import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { ARTIFACT_LINES, artifactId, findLine, GROUP } from '../artifacts.js';
import { detectLoaders, detectProject, readGradleProperties } from '../detect.js';
import { line, printJson } from '../output.js';
import { commandExists } from '../xvfb.js';
import type { GlobalOptions } from './context.js';

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
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
  { host: 'maven.pkg.github.com', why: 'CyclopsMC packages, including ClientDevBridge itself' },
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

function javaCheck(): Check {
  // `java -version` reports on stderr, and some environments prepend a JAVA_TOOL_OPTIONS notice,
  // so both streams are read and searched rather than just stdout.
  const probe = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (probe.error !== undefined && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return {
      name: 'java',
      ok: false,
      detail: 'not found on PATH',
      fix: 'Install a JDK 21, e.g. sudo apt-get install -y openjdk-21-jdk',
    };
  }
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;

  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  const versionLine = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.includes('version "'));
  if (match === null) {
    return {
      name: 'java',
      ok: false,
      detail: `could not parse the version from: ${output.trim().split('\n')[0] ?? '(no output)'}`,
      fix: 'Make sure `java -version` works and reports Java 21 or newer.',
    };
  }
  const major = Number(match[1]);
  return {
    name: 'java',
    ok: major >= 21,
    detail: versionLine ?? `Java ${major}`,
    fix: major >= 21 ? '' : `Minecraft 1.21+ needs Java 21, but found Java ${major}. Install it, e.g. sudo apt-get install -y openjdk-21-jdk`,
  };
}

export async function collectChecks(
  projectDir: string,
  options: { network: boolean; loader?: string | undefined },
): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(javaCheck());

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
    line(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(30)}  ${check.detail}`);
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
    line('Everything checks out. Run: clientdevbridge start');
  }
  return failures.length === 0 ? 0 : 2;
}
