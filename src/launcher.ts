import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { CliError, SessionError } from './errors.js';
import { detectProject, type Loader } from './detect.js';
import { pinOptions, renderInitScript } from './initscript.js';
import { ensureDirectories, ensureGitignore, resolvePaths } from './paths.js';
import { clearSession, isProcessAlive, readSession, type Session, writeSession } from './session.js';
import { BridgeClient } from './protocol/client.js';
import { planDisplay } from './xvfb.js';
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
    throw new CliError(
      `Port ${options.port} on 127.0.0.1 is already in use, so the client could not claim it.`,
      2,
      'Pass --port <other> to use a different one, or stop whatever is listening there.',
    );
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

  const child = spawn(display.command, args, {
    cwd: project.projectDir,
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: { ...process.env, ...display.env },
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
  };
  writeSession(paths, session);

  const hello = await waitForHandshake(session, paths.gradleLog, options.timeoutMs, options.onProgress);
  return { session, hello };
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
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;

  while (Date.now() < deadline) {
    if (!isProcessAlive(session.pid)) {
      throw new SessionError(
        `Gradle exited before the client came up.\n${tailFile(gradleLog, 25)}`,
        `The full log is at ${gradleLog}.`,
      );
    }
    if (!(await isPortFree(session.port))) {
      try {
        const client = await BridgeClient.connect({ port: session.port, timeoutMs: 10_000 });
        const hello = client.hello;
        client.close();
        return hello;
      } catch {
        // The port is open but the handshake is not finished; keep waiting.
      }
    }
    if (Date.now() - lastReport > 15_000) {
      lastReport = Date.now();
      onProgress?.(`Still starting... (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s) ${lastGradleLine(gradleLog)}`);
    }
    await delay(500);
  }

  throw new SessionError(
    `The client did not answer on port ${session.port} within ${Math.round(timeoutMs / 1000)}s.\n${tailFile(gradleLog, 25)}`,
    `Increase --timeout, or read the full log at ${gradleLog}.`,
  );
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
export async function stop(projectDir: string): Promise<{ stopped: boolean; wasStale: boolean }> {
  const status = readSession(projectDir);
  if (status.session === null) {
    return { stopped: false, wasStale: status.stale };
  }
  if (status.stale) {
    clearSession(status.paths);
    return { stopped: false, wasStale: true };
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

  clearSession(status.paths);
  return { stopped: true, wasStale: false };
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
