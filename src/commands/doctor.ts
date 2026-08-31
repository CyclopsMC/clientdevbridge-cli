import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { ARTIFACT_LINES, artifactId, findLine, GROUP } from '../artifacts.js';
import { declaredJavaVersion, detectLoaders, detectProject, projectPathOf, readGradleProperties } from '../detect.js';
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
  options: { network: boolean; dependencies: boolean; loader?: string | undefined },
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

      if (options.dependencies) {
        // Against the module that actually gets launched, not the root. A multiloader root is an
        // empty aggregator with no compileClasspath at all, so resolving there failed on every
        // Cyclops mod -- a false alarm on exactly the layout this tool is built for.
        checks.push(resolveDependencies(projectDir, wrapper, projectPathOf(project.gradleTask),
          findJavaHome(declaredJavaVersion(readGradleProperties(projectDir)))?.home ?? null));
      }

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

/**
 * Asks Gradle to resolve the project's own compile classpath, and reports what it says.
 *
 * The network checks above are HTTPS HEAD probes, and reachability is not usability: GitHub
 * Packages answers a HEAD from anyone and then refuses to serve a dependency without credentials.
 * A cold start on a real repository saw "Everything checks out", then six and a half minutes of
 * Gradle, then `Username must not be null!` -- which is what a token with the wrong scope looks
 * like, and which this project's own docs already describe as unhelpful.
 *
 * Twenty seconds of Gradle here is worth six minutes of Gradle there. It is opt-out rather than
 * opt-in because the caller who most needs it is the one who does not know to ask.
 */
function resolveDependencies(
  projectDir: string,
  wrapper: string,
  gradlePath: string,
  javaHome: string | null,
): Check {
  const task = gradlePath === ':' ? ':dependencies' : `${gradlePath}:dependencies`;
  const result = spawnSync(
    wrapper,
    ['--quiet', '--console=plain', task, '--configuration', 'compileClasspath'],
    {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, ...(javaHome === null ? {} : { JAVA_HOME: javaHome }) },
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    // A warn, not an ok. Four minutes without resolving means the caches are cold, and a cold cache
    // is the single best predictor of a first `start` that takes 15-20 minutes -- which is the one
    // thing a first-time caller most needs to be told. Reported as `ok` beside genuinely fine
    // things, it set exactly the wrong expectation.
    return {
      name: 'dependencies',
      ok: true,
      workedAround: true,
      detail: 'still resolving after 4 minutes: the caches are cold, so the first start will take 15-20 minutes',
      fix: '`start` allows for that automatically on a cold machine. Nothing to do -- but do not '
        + 'take the first long wait for a hang.',
    };
  }
  if (result.status === 0) {
    return { name: 'dependencies', ok: true, detail: 'the project resolves its compile classpath', fix: '' };
  }

  // A project with no compile classpath has nothing to resolve, which is an answer and not a
  // failure: some layouts put every dependency on a configuration of their own.
  if (output.includes("configuration 'compileClasspath' not found")) {
    return {
      name: 'dependencies',
      ok: true,
      detail: `${task === ':dependencies' ? 'the project' : gradlePath} declares no compile classpath, so there was nothing to resolve`,
      fix: '',
    };
  }

  // The message Gradle gives for GitHub Packages without usable credentials names neither the
  // repository nor the credential, so it is worth translating once rather than by every caller.
  const credentials = output.includes('Username must not be null')
    || output.includes('Received status code 401');
  return {
    name: 'dependencies',
    ok: false,
    detail: credentials
      ? 'a repository refused the credentials it was given'
      : (whatWentWrong(output) ?? 'gradle could not resolve them'),
    fix: credentials
      ? 'A Maven the project declares needs credentials this environment does not have. For CyclopsMC '
        + 'packages set GITHUB_USER and a GITHUB_TOKEN with read:packages, or build the missing '
        + 'dependencies from source with `./gradlew publishToMavenLocal` in their repositories. '
        + 'See docs/cloud-setup.md in the mod repository.'
      : `Run \`./gradlew ${task} --configuration compileClasspath\` to see the whole failure.`,
  };
}

/**
 * Gradle's own one-line summary of a failure, which it prints after "* What went wrong:".
 *
 * Better than matching on the shapes of individual failures: it is the same place for a missing
 * plugin, an unresolvable coordinate and a repository refusing credentials, so this keeps working
 * for the failure nobody predicted.
 */
function whatWentWrong(output: string): string | undefined {
  const lines = output.split('\n');
  const header = lines.findIndex((entry) => entry.trim() === '* What went wrong:');
  if (header < 0) {
    return undefined;
  }
  const said = lines
    .slice(header + 1, header + 4)
    .map((entry) => entry.trim().replace(/^>\s*/, ''))
    .filter((entry) => entry.length > 0);
  return said.length === 0 ? undefined : said.join(' ');
}

export async function runDoctor(
  global: GlobalOptions,
  options: { network: boolean; dependencies: boolean; loader?: string | undefined },
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
