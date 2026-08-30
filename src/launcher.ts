import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { CliError, SessionError } from './errors.js';
import { resolveJavaHome } from './java.js';
import { detectProject, type Loader } from './detect.js';
import { pinOptions, renderInitScript } from './initscript.js';
import { ensureDirectories, ensureGitignore, resolvePaths } from './paths.js';
import { clearSession, isProcessAlive, readSession, type Session, writeSession } from './session.js';
import { BridgeClient } from './protocol/client.js';
import { planDisplay, xvfbPids } from './xvfb.js';
import { artifactId, findLine, GROUP, unsupportedMessage } from './artifacts.js';

export const DEFAULT_PORT = 25599;
export const DEFAULT_WIDTH = 854;
export const DEFAULT_HEIGHT = 480;
export const DEFAULT_USERNAME = 'ClientDevBridge';

/** gradle.log is truncated to this size, so a long session cannot fill the disk. */
const GRADLE_LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface StartOptions {
  readonly projectDir: string;
  readonly loader?: Loader | undefined;
  readonly minecraftVersion?: string | undefined;
  readonly bridgeVersion?: string | undefined;
  readonly world?: string | undefined;
  readonly headed: boolean;
  readonly port: number;
  readonly timeoutMs: number;
  readonly gradleArgs: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly evalEnabled: boolean;
  readonly pinOptions: boolean;
  readonly jdwpPort: number | null;
  readonly onProgress?: (line: string) => void;
}

/**
 * Best-effort identification of whatever holds a port, for the orphaned-client message.
 * Returns null when the platform has no tool for it; this is a nicety, never a requirement.
 */
/**
 * Removes Loom's cached *remapped* copy of the bridge mod.
 *
 * Loom remaps every mod on the dev runtime classpath and caches the result keyed by group,
 * artifact and version. A local build republished under the same version (`1.0.0-DEV`, say) is
 * therefore never re-read: the client silently keeps running the previous build, which looks
 * exactly like the new code having no effect. NeoGradle uses the jar directly and does not have
 * this problem, so it only ever bites on Fabric — and only while developing ClientDevBridge
 * itself, which is precisely when it is most confusing.
 *
 * Only local builds are affected: a released version is immutable, so its cache entry is correct.
 */
export function clearLoomRemapCache(projectDir: string, minecraftVersion: string, loader: Loader): string[] {
  if (loader !== 'fabric') {
    return [];
  }
  const cleared: string[] = [];
  const artifact = artifactId(minecraftVersion, loader);

  for (const cacheRoot of findLoomCaches(projectDir)) {
    const stack = [cacheRoot];
    while (stack.length > 0) {
      const directory = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const full = path.join(directory, entry.name);
        if (entry.name === artifact) {
          fs.rmSync(full, { recursive: true, force: true });
          cleared.push(full);
        } else {
          stack.push(full);
        }
      }
    }
  }
  return cleared;
}

function findLoomCaches(projectDir: string): string[] {
  const roots: string[] = [];
  const candidates = [projectDir, ...fs
    .readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('loader-'))
    .map((entry) => path.join(projectDir, entry.name))];

  for (const candidate of candidates) {
    const cache = path.join(candidate, '.gradle', 'loom-cache', 'remapped_mods');
    if (fs.existsSync(cache)) {
      roots.push(cache);
    }
  }
  return roots;
}

/**
 * Asks whatever is listening on the bridge port who it is.
 *
 * A client on the port is not automatically an orphan: a mod developer with two checkouts open
 * hits this constantly, and telling them to `kill` a perfectly healthy client of their own is bad
 * advice given confidently. A ClientDevBridge client answers with the project it belongs to.
 */
export async function describeBridgeOnPort(
  port: number,
): Promise<{ projectDir: string | null; mcVersion: string; loader: string } | null> {
  try {
    const client = await BridgeClient.connect({ port, timeoutMs: 3_000 });
    const hello = client.hello;
    client.close();
    return {
      projectDir: hello.projectDir ?? null,
      mcVersion: hello.mcVersion,
      loader: hello.loader,
    };
  } catch {
    // Not a bridge, or not answering: the caller falls back to the pid it can see.
    return null;
  }
}

/** What to tell someone whose bridge port is already taken. */
export function hintForOccupiedPort(
  port: number,
  owner: string | null,
  bridge: { projectDir: string | null; mcVersion: string; loader: string } | null,
  thisProject: string,
): string {
  if (bridge === null) {
    return owner === null
      ? `Pass --port <other> to use a different one, or stop whatever is listening on ${port}.`
      : `Something that is not a ClientDevBridge client holds it: pid ${owner}. ` +
        `Stop it with 'kill ${owner.split(' ')[0]}', or start this one elsewhere with --port <other>.`;
  }
  const where = bridge.projectDir;
  if (where !== null && path.resolve(where) !== path.resolve(thisProject)) {
    return (
      `A ClientDevBridge client for another project holds it (Minecraft ${bridge.mcVersion}, ${bridge.loader}):\n` +
      `      ${where}\n` +
      `    Stop that one with 'clientdevbridge --project ${where} stop', or run this one alongside ` +
      'it with --port <other>.'
    );
  }
  return (
    `A ClientDevBridge client for this project already holds it (Minecraft ${bridge.mcVersion}, ` +
    `${bridge.loader}), but its session file is gone, so 'stop' cannot find it. ` +
    (owner === null
      ? 'Stop it by hand, or start elsewhere with --port <other>.'
      : `Stop it with 'pkill -g $(ps -o pgid= -p ${owner.split(' ')[0]} | tr -d " ")', or start ` +
        'elsewhere with --port <other>.')
  );
}

export function describePortOwner(port: number): string | null {
  if (process.platform === 'win32') {
    return null;
  }
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = /^p(\d+)/m.exec(output);
    if (pid !== null) {
      const name = /^c(.+)$/m.exec(output);
      return `${pid[1]} (${name === null ? 'unknown' : name[1]})`;
    }
  } catch {
    // lsof is missing or found nothing; the caller falls back to a generic hint.
  }
  return null;
}

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * Launches a client and waits until it answers the handshake.
 *
 * The process is detached into its own group so it survives this short-lived CLI invocation;
 * `stop` later kills the whole group, which is what actually reaps Gradle's forked JVM.
 */
export async function start(options: StartOptions): Promise<{ session: Session; hello: unknown }> {
  const project = detectProject(options.projectDir, {
    loader: options.loader,
    minecraftVersion: options.minecraftVersion,
  });
  const paths = resolvePaths(project.projectDir);

  const existing = readSession(project.projectDir);
  if (existing.session !== null && !existing.stale) {
    throw new CliError(
      `A ClientDevBridge client is already running for ${project.projectDir} (pid ${existing.session.pid}, port ${existing.session.port}).`,
      2,
      "Run 'clientdevbridge stop' first, or 'clientdevbridge restart' to replace it.",
    );
  }
  if (existing.stale) {
    clearSession(paths);
  }

  const bridgeVersion = options.bridgeVersion ?? resolveBridgeVersion(project.minecraftVersion, project.loader);

  if (!(await isPortFree(options.port))) {
    // Whose client it is decides the advice. A ClientDevBridge client answers with the project it
    // was launched for, and the common case by far is another checkout of the developer's own --
    // telling them to kill it is confident, wrong, and worse than saying nothing. Even for a
    // client of this project, `kill <pid>` names the java process, whose process group is not the
    // xvfb-run one the session tracks, so it leaves the virtual display behind; `stop` does not.
    const owner = describePortOwner(options.port);
    const bridge = await describeBridgeOnPort(options.port);
    throw new CliError(
      `Port ${options.port} on 127.0.0.1 is already in use, so the client could not claim it.`,
      2,
      hintForOccupiedPort(options.port, owner, bridge, project.projectDir),
    );
  }

  // A mavenLocal build means someone is iterating on ClientDevBridge itself, and Loom would
  // otherwise keep serving the previously remapped copy of the same version.
  if (options.bridgeVersion === undefined && newestInMavenLocal(project.minecraftVersion, project.loader) !== null) {
    const cleared = clearLoomRemapCache(project.projectDir, project.minecraftVersion, project.loader);
    if (cleared.length > 0) {
      options.onProgress?.(`Cleared Loom's cached remap of the local build (${cleared.length} entry/entries)`);
    }
  }

  ensureDirectories(paths);
  if (ensureGitignore(paths)) {
    options.onProgress?.(`Added .clientdevbridge/ to ${path.join(project.projectDir, '.gitignore')}`);
  }

  fs.writeFileSync(
    paths.initScript,
    renderInitScript({
      minecraftVersion: project.minecraftVersion,
      loader: project.loader,
      bridgeVersion,
      port: options.port,
      evalEnabled: options.evalEnabled,
      world: options.world ?? null,
      username: DEFAULT_USERNAME,
      width: options.width,
      height: options.height,
      jdwpPort: options.jdwpPort,
      projectDir: project.projectDir,
      // The Gradle path of the module being launched: ':loader-neoforge:runClient' -> ':loader-neoforge'.
      targetProjectPath: project.gradleTask.replace(/:runClient$/, '') || ':',
    }),
    'utf8',
  );

  if (options.pinOptions) {
    const result = pinOptions(project.runDir);
    if (result.changed.length > 0) {
      options.onProgress?.(
        `Pinned determinism options in ${path.join(project.runDir, 'options.txt')} (changed: ${result.changed.join(', ')})`,
      );
    }
  }

  const gradleArgs = [
    project.gradleTask,
    '--init-script',
    paths.initScript,
    '--console=plain',
    '--no-daemon',
    ...options.gradleArgs,
  ];

  const display = planDisplay(project.gradleWrapper, {
    headed: options.headed,
    width: options.width,
    height: options.height,
  });
  options.onProgress?.(`Display: ${display.description}`);

  const args =
    display.command === project.gradleWrapper
      ? gradleArgs
      : [...display.prefixArgs, project.gradleWrapper, ...gradleArgs];

  fs.writeFileSync(paths.gradleLog, '', 'utf8');
  const logStream = fs.openSync(paths.gradleLog, 'a');

  // xvfb-run picks a free display itself and never says which, so the only way to know what it
  // started is to compare before and after.
  const xvfbBefore = new Set(xvfbPids());

  // Gradle runs on JAVA_HOME, not on whatever `java` the PATH resolves to, and the loader plugins
  // check that JDK rather than the toolchain: Loom refuses to configure a Minecraft 26 project on
  // Java 21, during configuration, with an error that never mentions JAVA_HOME. Point Gradle at a
  // JDK that satisfies the project when the environment's own does not.
  const java = resolveJavaHome(project.javaVersion);
  if (java.substituted) {
    options.onProgress?.(
      `This project needs Java ${project.javaVersion}; running Gradle on ${java.javaHome} ` +
        `(Java ${java.probe.major}) instead of the environment's own.`,
    );
  }

  const child = spawn(display.command, args, {
    cwd: project.projectDir,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: {
      ...process.env,
      ...(java.javaHome === null ? {} : { JAVA_HOME: java.javaHome }),
      ...display.env,
    },
  });
  child.unref();

  if (child.pid === undefined) {
    throw new CliError('Failed to spawn Gradle.', 2);
  }

  const session: Session = {
    version: 1,
    port: options.port,
    pid: child.pid,
    pgid: child.pid,
    loader: project.loader,
    mcVersion: project.minecraftVersion,
    bridgeVersion,
    projectDir: project.projectDir,
    gradleTask: project.gradleTask,
    startedAt: new Date().toISOString(),
    world: options.world ?? null,
    headed: options.headed,
    display: display.description,
    jdwpPort: options.jdwpPort,
    xvfbPids: [],
  };
  writeSession(paths, session);

  const { hello, gameDir } = await waitForHandshake(
    session,
    paths.gradleLog,
    options.timeoutMs,
    options.onProgress,
  );
  // Now, not right after the spawn: Gradle takes most of a minute to get as far as launching the
  // client, and xvfb-run only starts a server when it does. A client that has answered has one.
  const started = { ...session, xvfbPids: xvfbPids().filter((pid) => !xvfbBefore.has(pid)) };
  writeSession(paths, started);

  if (options.pinOptions && gameDir !== null && path.resolve(gameDir) !== path.resolve(project.runDir)) {
    // The guess was wrong, so this run is not pinned. Pin the directory the client actually named,
    // which is also what `detectRunDir` will find next time, and say so rather than let the next
    // screenshot comparison fail for a reason nothing points at.
    pinOptions(gameDir);
    options.onProgress?.(
      `The client runs in ${gameDir}, not ${project.runDir}. Pinned the determinism options there; ` +
        'restart to apply them to a running client.',
    );
  }
  return { session: started, hello };
}

/**
 * Picks which ClientDevBridge build to inject.
 *
 * A build in the local Maven repository always wins, because the only reason one is there is that
 * someone is working on ClientDevBridge itself and wants to test that build. Otherwise Gradle is
 * asked for the newest release in the line; `--clientdevbridge-version` overrides both.
 */
function resolveBridgeVersion(minecraftVersion: string, loader: Loader): string {
  if (findLine(minecraftVersion) === undefined) {
    throw new CliError(unsupportedMessage(minecraftVersion), 2);
  }
  const local = newestInMavenLocal(minecraftVersion, loader);
  return local ?? '+';
}

export function newestInMavenLocal(minecraftVersion: string, loader: Loader): string | null {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (home === undefined) {
    return null;
  }
  const directory = path.join(
    home,
    '.m2',
    'repository',
    GROUP.replace(/\./g, path.sep),
    artifactId(minecraftVersion, loader),
  );
  if (!fs.existsSync(directory)) {
    return null;
  }
  const versions = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return versions.length === 0 ? null : (versions[versions.length - 1] as string);
}

async function waitForHandshake(
  session: Session,
  gradleLog: string,
  timeoutMs: number,
  onProgress?: (line: string) => void,
): Promise<{ hello: unknown; gameDir: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  // What the loop last observed, so that giving up can say which of the several quite different
  // reasons it was still waiting for: nothing listening, a socket that never handshakes, or a
  // client that answers and simply is not ready.
  let attempts = 0;
  let lastObservation = 'the port was never reachable';

  while (Date.now() < deadline) {
    if (!isProcessAlive(session.pid)) {
      throw new SessionError(
        `Gradle exited before the client came up.\n${tailFile(gradleLog, 25)}`,
        `The full log is at ${gradleLog}.`,
      );
    }
    if (!(await isPortFree(session.port))) {
      attempts += 1;
      try {
        const client = await BridgeClient.connect({ port: session.port, timeoutMs: 10_000 });
        // The socket opens during mod initialisation, long before the game is usable: the
        // resource reload is still running, no client ticks are happening, and the next command
        // would race the startup. Wait for the game to actually be up.
        const status = await client.call<Record<string, unknown>>('status', {}, 10_000);
        const ready = status['loaded'] === true;
        const hello = client.hello;
        const reported = status['gameDir'];
        client.close();
        if (ready) {
          return { hello, gameDir: typeof reported === 'string' ? reported : null };
        }
        lastObservation =
          `the client answered but was not ready yet (screen ${String(status['screenClass'] ?? 'none')}, ` +
          `inWorld ${String(status['inWorld'])}, tick ${String(status['tick'])}, fps ${String(status['fps'])})`;
      } catch (error) {
        lastObservation = `connecting to the open port failed: ${(error as Error).message}`;
      }
    }
    if (Date.now() - lastReport > 15_000) {
      lastReport = Date.now();
      onProgress?.(`Still starting... (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s) ${lastGradleLine(gradleLog)}`);
    }
    await delay(500);
  }

  // A client that never answers is blocked on something, and the log cannot say what: it simply
  // stops. Ask the JVM for a thread dump before giving up, so the render thread's stack lands in
  // the game log where whoever debugs this will look.
  const dumped = await requestThreadDump();
  throw new SessionError(
    `The client did not answer on port ${session.port} within ${Math.round(timeoutMs / 1000)}s.\n` +
      `Reached the port ${attempts} time(s); last time, ${lastObservation}.\n${tailFile(gradleLog, 25)}`,
    dumped
      ? `A thread dump was appended to ${gradleLog}. The stack of "Render thread" is what stalled; ` +
        'increase --timeout only if it shows real work in progress.'
      : `Increase --timeout, or read the full log at ${gradleLog}.`,
  );
}

/** Whether a pid belongs to a JVM, which is the only kind of process SIGQUIT is safe to send to. */
function isJavaProcess(pid: number): boolean {
  try {
    const command = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.basename(command) === 'java';
  } catch {
    return false;
  }
}

/**
 * Asks the client JVM to print every thread's stack into the game log.
 *
 * SIGQUIT makes a JVM dump its threads to its own stdout, which the launcher is already capturing
 * into gradle.log -- so the evidence ends up in the file the error message points at, with no
 * debugger and no second run.
 *
 * Only the client JVM is signalled, located by the system property that launched it. Signalling
 * the process group instead would reach xvfb-run and Xvfb, for which SIGQUIT is fatal: that would
 * take the display down and destroy the very evidence being collected.
 *
 * @return whether a dump was requested from at least one process
 */
export async function requestThreadDump(): Promise<boolean> {
  let pids: number[];
  try {
    // The `--` matters: the pattern starts with a dash, and without it pgrep reads it as options
    // and exits with "invalid option -- 'D'" -- which the catch below would quietly turn into
    // "no dump available", exactly when a dump is what is needed.
    pids = execFileSync('pgrep', ['-f', '--', '-Dclientdevbridge.enabled=true'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    // pgrep exits 1 when it simply matched nothing, and >1 when the call itself was wrong. Those
    // are very different, and collapsing them is how a bug hid here once already: the pattern
    // starts with a dash, pgrep rejected it as an option, and the failure looked exactly like
    // "there is no client to dump".
    const status = (error as { status?: number }).status;
    if (status !== 1) {
      process.stderr.write(
        `Could not ask the client for a thread dump: pgrep exited ${status ?? 'abnormally'}.\n`,
      );
    }
    return false;
  }

  let signalled = false;
  for (const pid of pids) {
    // Only ever signal a JVM. `pgrep -f` matches on the whole command line, so it also finds
    // anything that merely mentions the property -- a shell grepping for it, an editor with the
    // init script open. SIGQUIT is a thread dump to a JVM and a *kill* to everything else, so
    // signalling an unchecked match would terminate an innocent process while trying to debug.
    if (!isJavaProcess(pid)) {
      continue;
    }
    try {
      process.kill(pid, 'SIGQUIT');
      signalled = true;
    } catch {
      // Already gone.
    }
  }
  if (signalled) {
    // The dump is written asynchronously by the JVM; give it a moment to reach the log file.
    await delay(3_000);
  }
  return signalled;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tailFile(file: string, lines: number): string {
  if (!fs.existsSync(file)) {
    return '(no log yet)';
  }
  const content = readTruncated(file);
  const all = content.split('\n').filter((line) => line.length > 0);
  return all.slice(-lines).join('\n');
}

function lastGradleLine(file: string): string {
  const tail = tailFile(file, 1);
  return tail.length > 160 ? `${tail.slice(0, 157)}...` : tail;
}

/** Reads at most the last {@link GRADLE_LOG_MAX_BYTES} of a file, so a huge log cannot blow up memory. */
export function readTruncated(file: string): string {
  const stat = fs.statSync(file);
  if (stat.size <= GRADLE_LOG_MAX_BYTES) {
    return fs.readFileSync(file, 'utf8');
  }
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(GRADLE_LOG_MAX_BYTES);
    fs.readSync(handle, buffer, 0, GRADLE_LOG_MAX_BYTES, stat.size - GRADLE_LOG_MAX_BYTES);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Kills the whole process group, so Gradle, xvfb-run, and the forked client JVM all go together.
 */
export async function stop(
  projectDir: string,
  port = DEFAULT_PORT,
): Promise<{ stopped: boolean; wasStale: boolean; orphan: string | null }> {
  const status = readSession(projectDir);
  if (status.session === null) {
    // No session file, but something may still be holding the port: a client whose session.json
    // was deleted is exactly the case where a caller most needs to be told, rather than quietly
    // told "nothing was running" while a Minecraft client keeps going.
    const orphan = (await isPortFree(port)) ? null : describePortOwner(port);
    return { stopped: false, wasStale: status.stale, orphan };
  }
  if (status.stale) {
    clearSession(status.paths);
    const orphan = (await isPortFree(status.session.port)) ? null : describePortOwner(status.session.port);
    return { stopped: false, wasStale: true, orphan };
  }

  const pgid = status.session.pgid;
  signalGroup(pgid, 'SIGTERM');

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && isProcessAlive(status.session.pid)) {
    await delay(250);
  }
  if (isProcessAlive(status.session.pid)) {
    signalGroup(pgid, 'SIGKILL');
    await delay(500);
  }

  await reapXvfb(status.session.xvfbPids ?? []);

  clearSession(status.paths);
  return { stopped: true, wasStale: false, orphan: null };
}

/**
 * Kills the Xvfb servers a launch started.
 *
 * Killing the process group does not reliably take them: xvfb-run backgrounds Xvfb and relies on
 * its own exit trap to clean up, and the trap does not run when the group is killed. The leak is
 * not harmless -- Xvfb keeps its display's lock, and a later run that lands on that display dies
 * with an X GLX BadAccess before it renders anything.
 *
 * Only pids recorded by this session are touched, so another project's client is never disturbed.
 */
async function reapXvfb(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone, which is the common case: xvfb-run's trap does sometimes get to run.
    }
  }

  // Wait for them to actually go. A dying X server still holds its display lock, and `xvfb-run -a`
  // picks a display by looking at exactly those locks -- so returning early lets the next `start`
  // land on a server that is halfway through shutting down, which fails with an X GLX BadAccess
  // long after anything useful could point at the cause.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(isProcessAlive)) {
    await delay(100);
  }
  for (const pid of pids.filter(isProcessAlive)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Raced with its own exit.
    }
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    // A negative pid addresses the whole process group.
    process.kill(-pgid, signal);
  } catch {
    try {
      process.kill(pgid, signal);
    } catch {
      // Already gone.
    }
  }
}
