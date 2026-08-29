import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Finding the JDK Gradle will run on.
 *
 * This matters more than it looks like it should. The loader plugins check the JDK *Gradle itself*
 * is running on, not the toolchain: Loom refuses to configure a Minecraft 26 project when Gradle
 * runs on Java 21, with an error that arrives during configuration and never mentions JAVA_HOME.
 * And Gradle takes that JDK from `JAVA_HOME`, not from `java` on the PATH, so a machine with a
 * newer `java` first on the PATH and an older `JAVA_HOME` looks fine and is not.
 */

export interface JavaProbe {
  /** The JDK's home directory, or null when it was found on the PATH with no home to name. */
  readonly home: string | null;
  readonly major: number | null;
  /** Human-readable first line of `java -version`, for reporting. */
  readonly versionLine: string | null;
  /** Where this JDK came from, e.g. `JAVA_HOME` or `PATH`. */
  readonly source: string;
}

export function javaBinary(home: string | null): string {
  return home === null ? 'java' : path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

/** Runs `java -version` and reads the major version out of it. */
export function probeJava(home: string | null, source: string): JavaProbe {
  // `java -version` reports on stderr, and some environments prepend a JAVA_TOOL_OPTIONS notice,
  // so both streams are read and searched rather than just stdout.
  const probe = spawnSync(javaBinary(home), ['-version'], { encoding: 'utf8' });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const versionLine =
    output
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.includes('version "')) ?? null;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  // Java 8 and older report `1.8.0`; the major version is the second component there.
  const major =
    match === null ? null : Number(match[1]) === 1 ? Number(match[2] ?? '0') : Number(match[1]);
  return { home, major: Number.isNaN(major) ? null : major, versionLine, source };
}

/** The JDK Gradle would use with no help: `JAVA_HOME` when set, the PATH otherwise. */
export function gradleJava(): JavaProbe {
  const home = process.env['JAVA_HOME'];
  return home === undefined || home.length === 0
    ? probeJava(null, 'PATH')
    : probeJava(home, 'JAVA_HOME');
}

/**
 * Directories that conventionally hold one JDK each. Deliberately a short list of the layouts a
 * mod developer's machine actually has, rather than a filesystem search.
 */
function candidateRoots(): string[] {
  const home = os.homedir();
  return [
    '/usr/lib/jvm',
    '/usr/java',
    path.join(home, '.sdkman', 'candidates', 'java'),
    path.join(home, '.gradle', 'jdks'),
    '/Library/Java/JavaVirtualMachines',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
  ];
}

function javaHomesIn(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const homes: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const base = path.join(root, entry.name);
    // macOS buries the home one level down; everywhere else the directory is the home.
    for (const candidate of [base, path.join(base, 'Contents', 'Home')]) {
      if (fs.existsSync(javaBinary(candidate))) {
        homes.push(candidate);
        break;
      }
    }
  }
  return homes;
}

/**
 * Looks for an installed JDK of at least `requiredMajor`, preferring the lowest version that
 * qualifies: a mod that asks for Java 21 is built and tested on 21, and running Gradle on a much
 * newer JDK than the project expects trades one class of surprise for another.
 *
 * @return the JDK's home directory, or null when the machine has none
 */
export function findJavaHome(requiredMajor: number): JavaProbe | null {
  const found: JavaProbe[] = [];
  const seen = new Set<string>();
  for (const root of candidateRoots()) {
    for (const home of javaHomesIn(root)) {
      const real = fs.existsSync(home) ? fs.realpathSync(home) : home;
      if (seen.has(real)) {
        continue;
      }
      seen.add(real);
      const probe = probeJava(home, root);
      if (probe.major !== null && probe.major >= requiredMajor) {
        found.push(probe);
      }
    }
  }
  found.sort((left, right) => (left.major ?? 0) - (right.major ?? 0));
  return found[0] ?? null;
}

export interface JavaResolution {
  /** What Gradle should be run with; null means "leave the environment alone". */
  readonly javaHome: string | null;
  readonly probe: JavaProbe;
  /** Set when the environment's own JDK was too old and another one was found. */
  readonly substituted: boolean;
}

/**
 * Decides which JDK to run Gradle on.
 *
 * The environment's own choice wins whenever it is new enough — a developer who set `JAVA_HOME`
 * meant it. Only when it would fail outright does this go looking, and the caller says so rather
 * than silently running on a JDK nobody asked for.
 */
export function resolveJavaHome(requiredMajor: number): JavaResolution {
  const current = gradleJava();
  if (current.major !== null && current.major >= requiredMajor) {
    return { javaHome: current.home, probe: current, substituted: false };
  }
  const found = findJavaHome(requiredMajor);
  if (found === null || found.home === null) {
    return { javaHome: current.home, probe: current, substituted: false };
  }
  return { javaHome: found.home, probe: found, substituted: true };
}
