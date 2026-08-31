import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError } from './errors.js';

export type Loader = 'fabric' | 'neoforge';

export interface ProjectInfo {
  readonly projectDir: string;
  readonly minecraftVersion: string;
  readonly loader: Loader;
  /** The Gradle task that launches the client, e.g. `:loader-neoforge:runClient`. */
  readonly gradleTask: string;
  /** Where that task's working directory is, used to pin `options.txt`. */
  readonly runDir: string;
  readonly gradleWrapper: string;
  /**
   * The Java version the project declares. The loader plugins check the JDK Gradle itself runs on,
   * so this is not a toolchain hint that Gradle can satisfy on its own.
   */
  readonly javaVersion: number;
  /** How each value was arrived at, so `doctor` can explain itself. */
  readonly detected: { minecraftVersion: string; loader: string; gradleTask: string };
}

export function readGradleProperties(projectDir: string): Record<string, string> {
  const file = path.join(projectDir, 'gradle.properties');
  if (!fs.existsSync(file)) {
    return {};
  }
  const properties: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator > 0) {
      properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return properties;
}

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Every Gradle script that could say how this project is configured, as one blob to search. */
function buildSources(projectDir: string): string {
  return [
    readIfExists(path.join(projectDir, 'build.gradle')),
    readIfExists(path.join(projectDir, 'build.gradle.kts')),
    readIfExists(path.join(projectDir, 'settings.gradle')),
    ...['loader-fabric', 'loader-neoforge'].flatMap((module) => [
      readIfExists(path.join(projectDir, module, 'build.gradle')),
      readIfExists(path.join(projectDir, module, 'build.gradle.kts')),
    ]),
    ...(fs.existsSync(path.join(projectDir, 'buildSrc/src/main/groovy'))
      ? fs
          .readdirSync(path.join(projectDir, 'buildSrc/src/main/groovy'))
          .map((entry) => readIfExists(path.join(projectDir, 'buildSrc/src/main/groovy', entry)))
      : []),
  ].join('\n');
}

/**
 * Detects which loaders a checkout can run, by looking for the Gradle plugin each one applies.
 * ModDevGradle / NeoGradle mean NeoForge; Loom means Fabric.
 */
export function detectLoaders(projectDir: string): Loader[] {
  const sources = buildSources(projectDir);

  const loaders: Loader[] = [];
  if (/fabric-loom/.test(sources) || fs.existsSync(path.join(projectDir, 'loader-fabric'))) {
    loaders.push('fabric');
  }
  if (
    /net\.neoforged\.(moddev|gradle)/.test(sources) ||
    fs.existsSync(path.join(projectDir, 'loader-neoforge'))
  ) {
    loaders.push('neoforge');
  }
  return loaders;
}

/**
 * Picks the Gradle task that runs the client. Multiloader checkouts (the Cyclops layout) expose it
 * per loader module; a single-module mod exposes a plain `runClient`.
 */
export function detectGradleTask(projectDir: string, loader: Loader): { task: string; runDir: string } {
  const moduleName = `loader-${loader}`;
  if (fs.existsSync(path.join(projectDir, moduleName))) {
    const moduleDir = path.join(projectDir, moduleName);
    return { task: `:${moduleName}:runClient`, runDir: detectRunDir(moduleDir, projectDir, loader) };
  }
  // Fully qualified, so the Gradle path of the module being launched can be taken off it without
  // guessing. A bare 'runClient' used to be produced here, and the caller stripped the task name
  // with a pattern that needs the leading colon -- so on a single-module project the injection
  // target became the literal string 'runClient', no project matched it, and the init script
  // injected nothing anywhere. The client then boots as a plain dev client and never answers.
  return { task: ':runClient', runDir: detectRunDir(projectDir, projectDir, loader) };
}

/**
 * The Gradle path of the module a run task belongs to: ':loader-neoforge:runClient' is
 * ':loader-neoforge', and ':runClient' is the root project, ':'.
 */
export function projectPathOf(gradleTask: string): string {
  const lastColon = gradleTask.lastIndexOf(':');
  if (lastColon < 0) {
    return ':';
  }
  return lastColon === 0 ? ':' : gradleTask.slice(0, lastColon);
}

/**
 * Files and directories only the game itself creates. `options.txt` is deliberately not among
 * them: the CLI writes that one, so finding it proves nothing about where the game runs.
 */
const RUN_DIR_EVIDENCE = ['logs', 'saves', 'crash-reports', 'usercache.json'];

/**
 * Picks the directory the client will use as its game directory.
 *
 * There is no single answer to guess at: the run directory is chosen by the Gradle plugin, and the
 * conventions disagree. NeoGradle and the multiloader Loom convention use `runs/client`;
 * ModDevGradle 2, which is what the Minecraft 26 line builds on, uses `run`. Getting this wrong is
 * not loud — the determinism options are simply pinned into a file the game never reads, and the
 * first hint is a screenshot that does not match its golden.
 *
 * So: believe the evidence on disk when a previous run left some, and fall back to the convention
 * order otherwise. `start` corrects a wrong guess against the game directory the client reports
 * once it is up.
 */
export function detectRunDir(baseDir: string, projectDir = baseDir, loader?: Loader): string {
  const candidates = [path.join(baseDir, 'runs', 'client'), path.join(baseDir, 'run')];
  let best: { dir: string; usedAt: number } | null = null;
  for (const candidate of candidates) {
    for (const marker of RUN_DIR_EVIDENCE) {
      let usedAt: number;
      try {
        usedAt = fs.statSync(path.join(candidate, marker)).mtimeMs;
      } catch {
        continue;
      }
      // A checkout that switched Gradle plugins has both; the one used most recently is the live one.
      if (best === null || usedAt > best.usedAt) {
        best = { dir: candidate, usedAt };
      }
    }
  }
  if (best !== null) {
    return best.dir;
  }
  // Nothing has run yet, so ask the build what it is going to do. Getting this right on a cold
  // checkout is what keeps the very first launch deterministic -- and keeps `start` from opening
  // with a correction notice about a directory the caller never mentioned.
  const declared = declaredRunDir(buildSources(projectDir), loader);
  return declared === null ? candidates[0]! : path.join(baseDir, ...declared.split('/'));
}

/**
 * The run directory the build declares, as a path relative to the module.
 *
 * Loom's multiloader convention states it outright. The NeoForge plugins do not, and the two
 * generations disagree: NeoGradle runs in `runs/<name>`, ModDevGradle 2 -- which the Minecraft 26
 * line builds on -- in `run`.
 *
 * @return the declared directory, or null when the build says nothing useful
 */
function declaredRunDir(sources: string, loader?: Loader): string | null {
  if (loader === 'fabric') {
    const explicit = /\brunDir\s*[( ]\s*['"]([^'"]+)['"]/.exec(sources);
    return explicit === null ? null : explicit[1]!;
  }
  if (loader === 'neoforge') {
    if (/net\.neoforged\.moddev/.test(sources)) {
      return 'run';
    }
    if (/net\.neoforged\.gradle/.test(sources)) {
      return 'runs/client';
    }
  }
  return null;
}

/** Minecraft 1.21 needs Java 21 and Minecraft 26 needs 25; the project states which. */
export function declaredJavaVersion(properties: Record<string, string>): number {
  const declared = Number(properties['java_version'] ?? '21');
  return Number.isNaN(declared) ? 21 : declared;
}

export interface DetectOverrides {
  readonly minecraftVersion?: string | undefined;
  readonly loader?: Loader | undefined;
}

export function detectProject(projectDir: string, overrides: DetectOverrides = {}): ProjectInfo {
  const resolved = path.resolve(projectDir);
  const wrapper = path.join(resolved, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!fs.existsSync(wrapper)) {
    throw new CliError(
      `${resolved} does not look like a Gradle mod project: no gradlew wrapper found.`,
      2,
      'Pass --project <dir> pointing at the mod checkout you want to launch.',
    );
  }

  const properties = readGradleProperties(resolved);
  const minecraftVersion = overrides.minecraftVersion ?? properties['minecraft_version'];
  if (minecraftVersion === undefined || minecraftVersion.length === 0) {
    throw new CliError(
      `Could not determine the Minecraft version of ${resolved}: no 'minecraft_version' in gradle.properties.`,
      2,
      'Pass --mc-version <version> explicitly.',
    );
  }

  const available = detectLoaders(resolved);
  let loader = overrides.loader;
  if (loader === undefined) {
    if (available.length === 0) {
      throw new CliError(
        `Could not determine the mod loader of ${resolved}: found neither Loom (Fabric) nor ModDevGradle/NeoGradle (NeoForge).`,
        2,
        'Pass --loader fabric|neoforge explicitly.',
      );
    }
    // NeoForge first when both are present: it is the primary loader in the Cyclops layout.
    loader = available.includes('neoforge') ? 'neoforge' : (available[0] as Loader);
  } else if (available.length > 0 && !available.includes(loader)) {
    throw new CliError(
      `${resolved} does not appear to support the ${loader} loader (detected: ${available.join(', ') || 'none'}).`,
      2,
      'Drop --loader to use the detected one.',
    );
  }

  const { task, runDir } = detectGradleTask(resolved, loader);
  return {
    projectDir: resolved,
    minecraftVersion,
    loader,
    gradleTask: task,
    runDir,
    javaVersion: declaredJavaVersion(properties),
    gradleWrapper: wrapper,
    detected: {
      minecraftVersion:
        overrides.minecraftVersion === undefined ? "gradle.properties 'minecraft_version'" : '--mc-version',
      loader: overrides.loader === undefined ? `applied Gradle plugins (${available.join(', ')})` : '--loader',
      gradleTask: fs.existsSync(path.join(resolved, `loader-${loader}`))
        ? 'multiloader layout'
        : 'single-module layout',
    },
  };
}
