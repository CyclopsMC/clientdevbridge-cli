import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { ARTIFACT_LINES, artifactId, findLine, GROUP } from '../artifacts.js';
import { declaredJavaVersion, detectLoaders, detectProject, readGradleProperties } from '../detect.js';
import { findJavaHome, gradleJava } from '../java.js';
import { line, printJson } from '../output.js';
import { commandExists } from '../xvfb.js';
import type { GlobalOptions } from './context.js';

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /**
   * True when the check passes only because the CLI works around something. Rendered as `warn`:
   * calling a machine whose JAVA_HOME is too old `ok` is technically true and reads as a
   * contradiction next to a detail that says "too old".
   */
  readonly workedAround?: boolean;
  /** What to actually do about it. Empty when the check passed. */
  readonly fix: string;
}

/**
 * The hosts a cold checkout has to reach to build and launch a dev client.
 * Verified empirically; see docs/cloud-setup.md.
 */
export const REQUIRED_HOSTS: readonly { host: string; why: string }[] = [
  { host: 'services.gradle.org', why: 'Gradle distribution for the wrapper' },
  { host: 'plugins.gradle.org', why: 'Gradle plugin portal (Loom, ModDevGradle)' },
  { host: 'repo.maven.apache.org', why: 'Maven Central' },
  { host: 'piston-meta.mojang.com', why: 'Minecraft version manifest' },
  { host: 'piston-data.mojang.com', why: 'Minecraft client and server jars' },
  { host: 'libraries.minecraft.net', why: 'Minecraft libraries (LWJGL, authlib)' },
  { host: 'resources.download.minecraft.net', why: 'Minecraft assets' },
  { host: 'maven.neoforged.net', why: 'NeoForge and NeoForm' },
  { host: 'maven.minecraftforge.net', why: 'srgutils/unsafe, pulled in by NeoGradle' },
  { host: 'maven.fabricmc.net', why: 'Fabric loader, Loom and intermediary mappings' },
  { host: 'maven.parchmentmc.org', why: 'Parchment parameter mappings' },
  { host: 'repo.spongepowered.org', why: 'Mixin' },
  { host: 'cyclopsmc.github.io', why: 'the ClientDevBridge builds, from the releases Maven' },
  { host: 'maven.pkg.github.com', why: 'CyclopsMC packages, if the mod under test needs them' },
  { host: 'registry.npmjs.org', why: 'the CLI itself, via npx' },
];

function reachable(host: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const request = https.request({ host, port: 443, method: 'HEAD', path: '/', timeout: timeoutMs }, (response) => {
      response.resume();
      // Any HTTP answer proves the host is reachable; 404 and 401 are perfectly normal for a root path.
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

function javaCheck(requiredMajor: number): Check {
  // The JDK that matters is the one Gradle runs on, which is JAVA_HOME's -- not whatever `java`
  // the PATH happens to resolve to first. A machine with a new `java` on the PATH and an older
  // JAVA_HOME passes every naive check and then fails during Gradle configuration.
  const current = gradleJava();
  if (current.major === null) {
    const missing = current.source === 'PATH' ? 'not found on PATH' : `not usable at ${current.home}`;
    return {
      name: 'java',
      ok: false,
      detail: `${missing} (this project needs Java ${requiredMajor})`,
      fix:
        `Install a JDK ${requiredMajor} and point JAVA_HOME at it:\n` +
        `      sudo apt-get install -y openjdk-${requiredMajor}-jdk\n` +
        `      export JAVA_HOME=/usr/lib/jvm/java-${requiredMajor}-openjdk-amd64`,
    };
  }

  const where = current.home === null ? 'on PATH' : `from ${current.source}=${current.home}`;
  if (current.major >= requiredMajor) {
    return {
      name: 'java',
      ok: true,
      detail: `${current.versionLine ?? `Java ${current.major}`} ${where} (this project needs ${requiredMajor})`,
      fix: '',
    };
  }

  // Too old, but `start` substitutes a good one when the machine has it, so this is a warning
  // about the environment rather than a reason not to try.
  const substitute = findJavaHome(requiredMajor);
  if (substitute !== null) {
    return {
      name: 'java',
      ok: true,
      workedAround: true,
      detail:
        `Java ${current.major} ${where} is too old for this project, which needs ${requiredMajor}; ` +
        `Gradle will be run on ${substitute.home} (Java ${substitute.major}) instead`,
      fix:
        `Nothing has to be done -- 'clientdevbridge start' substitutes that JDK itself. To stop ` +
        `every command mentioning it: export JAVA_HOME=${substitute.home}`,
    };
  }
  return {
    name: 'java',
    ok: false,
    detail: `Java ${current.major} ${where} (this project needs ${requiredMajor})`,
    fix:
      `This project needs Java ${requiredMajor}, but Gradle would run on Java ${current.major}, ` +
      'and no newer JDK was found in the usual places. Install it and point JAVA_HOME at it:\n' +
      `      sudo apt-get install -y openjdk-${requiredMajor}-jdk\n` +
      `      export JAVA_HOME=/usr/lib/jvm/java-${requiredMajor}-openjdk-amd64\n` +
      '    A Gradle toolchain is not enough here: the loader plugins refuse to configure when ' +
      'Gradle itself runs on an older JDK than the Minecraft version needs.',
  };
}

export async function collectChecks(
  projectDir: string,
  options: { network: boolean; loader?: string | undefined },
): Promise<Check[]> {
  const checks: Check[] = [];
  // The required Java version is a property of the project, not a constant: Minecraft 1.21 needs
  // 21 and 26 needs 25, and the loader plugins check the JDK Gradle itself runs on.
  checks.push(javaCheck(declaredJavaVersion(readGradleProperties(projectDir))));

  checks.push({
    name: 'node',
    ok: Number(process.versions.node.split('.')[0]) >= 20,
    detail: `v${process.versions.node}`,
    fix: Number(process.versions.node.split('.')[0]) >= 20 ? '' : 'clientdevbridge-cli needs Node 20 or newer.',
  });

  const wrapper = path.join(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const hasWrapper = fs.existsSync(wrapper);
  checks.push({
    name: 'gradle wrapper',
    ok: hasWrapper,
    detail: hasWrapper ? wrapper : `missing at ${wrapper}`,
    fix: hasWrapper ? '' : 'Point --project at a Gradle mod checkout.',
  });

  const headless = process.platform === 'linux' && (process.env['DISPLAY'] ?? '').length === 0;
  if (headless) {
    const hasXvfb = commandExists('xvfb-run');
    checks.push({
      name: 'xvfb',
      ok: hasXvfb,
      detail: hasXvfb ? 'xvfb-run available' : 'not installed and $DISPLAY is unset',
      fix: hasXvfb ? '' : 'sudo apt-get install -y xvfb',
    });

    const driDir = '/usr/lib/x86_64-linux-gnu/dri';
    const hasSoftwareGl = fs.existsSync(path.join(driDir, 'swrast_dri.so')) || fs.existsSync(path.join(driDir, 'kms_swrast_dri.so'));
    checks.push({
      name: 'mesa (software GL)',
      ok: hasSoftwareGl,
      detail: hasSoftwareGl ? `llvmpipe drivers present in ${driDir}` : `no swrast driver in ${driDir}`,
      fix: hasSoftwareGl ? '' : 'sudo apt-get install -y libgl1-mesa-dri mesa-utils',
    });
  }

  if (hasWrapper) {
    try {
      const project = detectProject(projectDir, { loader: options.loader as 'fabric' | 'neoforge' | undefined });
      checks.push({
        name: 'project',
        ok: true,
        detail: `Minecraft ${project.minecraftVersion}, ${project.loader}, task ${project.gradleTask}`,
        fix: '',
      });

      const artifactLine = findLine(project.minecraftVersion);
      checks.push({
        name: 'clientdevbridge build',
        ok: artifactLine !== undefined,
        detail:
          artifactLine === undefined
            ? `no branch maps to Minecraft ${project.minecraftVersion}`
            : `${GROUP}:${artifactId(project.minecraftVersion, project.loader)} from branch ${artifactLine.branch}`,
        fix:
          artifactLine === undefined
            ? `Supported lines: ${ARTIFACT_LINES.map((entry) => entry.branch).join(', ')}. ` +
              'Pass --clientdevbridge-version to pin a build explicitly.'
            : '',
      });

      const localRepo = path.join(
        process.env['HOME'] ?? '',
        '.m2/repository',
        GROUP.replace(/\./g, '/'),
        artifactId(project.minecraftVersion, project.loader),
      );
      const inMavenLocal = fs.existsSync(localRepo);
      checks.push({
        name: 'mavenLocal build',
        ok: true,
        detail: inMavenLocal
          ? `found ${localRepo}`
          : 'none (the released build from GitHub Packages will be used)',
        fix: '',
      });
    } catch (error) {
      checks.push({
        name: 'project',
        ok: false,
        detail: (error as Error).message,
        fix: 'Pass --mc-version and --loader explicitly.',
      });
    }
  }

  const properties = readGradleProperties(projectDir);
  if (properties['minecraft_version'] !== undefined) {
    checks.push({
      name: 'loaders available',
      ok: true,
      detail: detectLoaders(projectDir).join(', ') || 'none detected',
      fix: '',
    });
  }

  if (options.network) {
    const results = await Promise.all(REQUIRED_HOSTS.map(async (entry) => ({ entry, ok: await reachable(entry.host) })));
    for (const { entry, ok } of results) {
      checks.push({
        name: `net ${entry.host}`,
        ok,
        detail: ok ? entry.why : `unreachable (${entry.why})`,
        fix: ok ? '' : `Allow https://${entry.host} in the sandbox network policy.`,
      });
    }
  }

  return checks;
}

export async function runDoctor(
  global: GlobalOptions,
  options: { network: boolean; loader?: string | undefined },
): Promise<number> {
  const checks = await collectChecks(global.project, options);
  const failures = checks.filter((check) => !check.ok);

  if (global.json) {
    printJson({ ok: failures.length === 0, checks });
    return failures.length === 0 ? 0 : 2;
  }

  for (const check of checks) {
    const status = !check.ok ? 'FAIL' : check.workedAround === true ? 'warn' : 'ok  ';
    line(`${status}  ${check.name.padEnd(30)}  ${check.detail}`);
  }
  const warnings = checks.filter((check) => check.ok && check.workedAround === true);
  if (warnings.length > 0) {
    line('');
    line('Worked around:');
    for (const warning of warnings) {
      line(`  - ${warning.name}: ${warning.fix}`);
    }
  }
  if (failures.length > 0) {
    line('');
    line('To fix:');
    for (const failure of failures) {
      if (failure.fix.length > 0) {
        line(`  - ${failure.name}: ${failure.fix}`);
      }
    }
  } else {
    line('');
    // Naming the loader that was actually checked: on a multiloader project a bare `start` picks
    // NeoForge, so telling someone who ran `doctor --loader fabric` to run `start` sends them to a
    // different client than the one just vouched for.
    const loader = options.loader === undefined ? '' : ` --loader ${options.loader}`;
    line(`Everything checks out. Run: clientdevbridge start${loader}`);
  }
  return failures.length === 0 ? 0 : 2;
}
