import * as path from 'node:path';
import {
  COLD_CACHE_TIMEOUT_MS,
  DEFAULT_HEIGHT,
  DEFAULT_PORT,
  DEFAULT_USERNAME,
  DEFAULT_WIDTH,
  describeBridgeOnPort,
  hasToolchainCache,
  describePortOwner,
  isPortFree,
  start,
  stop,
  tailFile,
} from '../launcher.js';
import { formatDuration, keyValues, line, printJson } from '../output.js';
import { pendingOptionsRestores } from '../initscript.js';
import { readSession } from '../session.js';
import { BridgeClient } from '../protocol/client.js';
import { detectProject, type Loader } from '../detect.js';
import type { GlobalOptions } from './context.js';

export interface StartCommandOptions {
  readonly loader?: string | undefined;
  readonly mcVersion?: string | undefined;
  readonly clientdevbridgeVersion?: string | undefined;
  readonly world?: string | undefined;
  readonly headed: boolean;
  /** Absent unless the caller named one, which is what makes taking the next free port the default. */
  readonly port?: string | undefined;
  readonly timeout: string;
  readonly gradleArgs?: string | undefined;
  readonly width: string;
  readonly height: string;
  readonly eval: boolean;
  readonly pinOptions: boolean;
  readonly gitignore: boolean;
  readonly toasts: boolean;
  /** A port number, or true for `--jdwp-port` with no number, which means "any free one". */
  readonly jdwpPort?: string | boolean | undefined;
}

export async function runStart(global: GlobalOptions, options: StartCommandOptions): Promise<void> {
  // A cold toolchain cache means the first build spends fifteen to twenty minutes on Minecraft
  // itself before the client starts booting, and the default was picked on a machine where that
  // was already done. Raising the ceiling costs nothing when the client comes up quickly -- the
  // wait returns the moment it answers -- and saves reporting a healthy build as a failure.
  const loader = (options.loader as Loader | undefined)
    ?? detectProject(global.project, {}).loader;
  const cold = !hasToolchainCache(loader);
  const timeoutMs = options.timeout === START_DEFAULTS.timeout && cold
    ? COLD_CACHE_TIMEOUT_MS
    : Number(options.timeout) * 1000;
  if (cold && !global.quiet) {
    line(
      `No ${loader === 'fabric' ? 'Loom' : 'NeoForm'} cache on this machine, so Minecraft itself has ` +
        `to be built first: expect 15-20 minutes. Waiting up to ${Math.round(timeoutMs / 60_000)} minutes.`,
    );
  }

  const result = await start({
    projectDir: global.project,
    loader: options.loader as Loader | undefined,
    minecraftVersion: options.mcVersion,
    bridgeVersion: options.clientdevbridgeVersion,
    world: options.world,
    headed: options.headed,
    // Null rather than the default port: an unasked-for port is the first free one, so that a
    // second checkout can be started without being told about the first.
    port: options.port === undefined ? null : Number(options.port),
    timeoutMs,
    gradleArgs: options.gradleArgs === undefined ? [] : options.gradleArgs.split(' ').filter((a) => a.length > 0),
    width: Number(options.width),
    height: Number(options.height),
    evalEnabled: options.eval,
    toasts: options.toasts,
    pinOptions: options.pinOptions,
    gitignore: options.gitignore,
    jdwpPort: options.jdwpPort === undefined
      ? null
      : options.jdwpPort === true
        ? 'auto'
        : Number(options.jdwpPort),
    onProgress: global.quiet ? undefined : (message) => line(message),
  });

  if (global.json) {
    printJson({ session: result.session, hello: result.hello });
    return;
  }

  const hello = result.hello as Record<string, unknown>;
  line('ClientDevBridge is ready.');
  keyValues([
    ['project', result.session.projectDir],
    ['loader', result.session.loader],
    ['minecraft', String(hello['mcVersion'] ?? result.session.mcVersion)],
    ['mod version', String(hello['clientDevBridgeVersion'] ?? result.session.bridgeVersion)],
    ['protocol', String(hello['protocol'])],
    ['port', result.session.port],
    ['username', DEFAULT_USERNAME],
    ['world', result.session.world],
    ['eval', String(hello['evalEnabled'] ?? false)],
    // Not `?? false`: a mod too old to report the field would then read as "toasts are off", which
    // is exactly the confusion this line exists to prevent.
    ['toasts', hello['toastsEnabled'] === undefined
      ? 'unknown (this mod build does not report it)'
      : String(hello['toastsEnabled'])],
    // Fabric loads its API as ~50 separate modules, which turns this into a wall of names that
    // says nothing. What a caller needs from it is whether the mod under test is loaded.
    ['mods', summariseMods(hello['mods'] as string[] | undefined)],
  ]);
}

/** The mod list, shortened once it stops being readable. */
function summariseMods(mods: string[] | undefined, limit = 12): string[] {
  if (mods === undefined) {
    return [];
  }
  if (mods.length <= limit) {
    return mods;
  }
  return [...mods.slice(0, limit), `... and ${mods.length - limit} more`];
}

export async function runStop(global: GlobalOptions, options: { port?: string | undefined } = {}): Promise<void> {
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  const result = await stop(global.project, port);
  if (global.json) {
    printJson(result);
    return;
  }
  if (result.stopped) {
    line('Stopped the ClientDevBridge client.');
  } else if (result.wasStale) {
    line('No client was running; cleared a stale session file.');
  } else {
    line('No client was running.');
  }
  // Said out loud, because the file belongs to the developer and the tool having touched it at all
  // is the surprising part: a client run by hand afterwards would otherwise be at gui scale 2, FOV
  // 0 and muted, with nothing to connect that to this tool.
  for (const file of result.restoredOptions) {
    line(`Restored your ${file}.`);
  }
  if (result.orphan !== null) {
    line('');
    // result.port, not the one asked for: when a session was on record, the port it names is the
    // client's own, and --port only decides where to look when there is no session left to ask.
    for (const explanation of await describeOccupiedPort(result.port, result.orphan, global.project)) {
      line(explanation);
    }
    process.exitCode = 2;
  }
}


/**
 * Explains what is holding the bridge port.
 *
 * "An orphaned client whose session file is gone" is one possibility and not the likely one: a mod
 * developer with two checkouts open reaches this every time, and `kill <pid>` is confident, wrong
 * advice about a client they are still using.
 */
async function describeOccupiedPort(port: number, pid: string, thisProject: string): Promise<string[]> {
  const bridge = await describeBridgeOnPort(port);
  if (bridge === null) {
    return [
      `Something is listening on port ${port}: pid ${pid}, and it does not answer the bridge protocol.`,
      `Start elsewhere with --port <other>, or stop it with: kill ${pid.split(' ')[0]}`,
    ];
  }
  const where = bridge.projectDir;
  if (where !== null && path.resolve(where) !== path.resolve(thisProject)) {
    return [
      `A ClientDevBridge client is on port ${port} (pid ${pid}), but it belongs to another project:`,
      `  ${where}  (Minecraft ${bridge.mcVersion}, ${bridge.loader})`,
      `Drive it from there, stop it with: clientdevbridge --project ${where} stop`,
      'or start this project on a different port with --port <other>.',
    ];
  }
  return [
    `A ClientDevBridge client for this project is on port ${port} (pid ${pid}), but its session`,
    `file is gone (Minecraft ${bridge.mcVersion}, ${bridge.loader}), so the CLI cannot drive it.`,
    `Stop it with: kill ${pid.split(' ')[0]}`,
  ];
}

export async function runStatus(global: GlobalOptions): Promise<void> {
  const status = readSession(global.project);

  if (status.session === null || status.stale) {
    const reason = status.session === null && !status.stale ? 'no session recorded' : 'the recorded process is gone';
    // The session file is not the only evidence: a client whose session.json was deleted is still
    // running, and reporting it as gone is worse than reporting nothing at all.
    const port = status.session?.port ?? DEFAULT_PORT;
    const orphan = (await isPortFree(port)) ? null : describePortOwner(port);

    if (global.json) {
      printJson({ running: false, reason, project: status.paths.projectDir, orphanOnPort: orphan });
      return;
    }
    line(`Not running (${reason}) in ${status.paths.projectDir}.`);
    // The one thing that outlives a client: the determinism options written into the developer's
    // own options.txt. `stop` puts them back, but a client closed by hand never reached it, and a
    // hand-run client afterwards would be at gui scale 2 with no hint as to why.
    for (const file of pendingOptionsRestores(status.paths.optionsBackup)) {
      line(`Your ${file} is still pinned to the determinism settings. `
        + 'Run `clientdevbridge stop` to put it back.');
    }
    if (orphan !== null) {
      line('');
      for (const explanation of await describeOccupiedPort(port, orphan, status.paths.projectDir)) {
        line(explanation);
      }
      return;
    }
    line('Start one with: clientdevbridge start');
    // The log tail is what explains a crash. After a deliberate stop it is just noise, and a
    // cleanly stopped session leaves no marker to tell the two apart -- so only show it when the
    // client is recorded as having died rather than never having been tracked.
    if (status.stale) {
      const tail = tailFile(status.paths.gradleLog, 20);
      if (tail !== '(no log yet)' && tail.length > 0) {
        line('');
        line(`The client exited. Last 20 lines of ${status.paths.gradleLog}:`);
        line(tail);
      }
    }
    return;
  }

  const session = status.session;
  let live: Record<string, unknown> | null = null;
  let hello: Record<string, unknown> | null = null;
  let connectError: string | null = null;
  try {
    const client = await BridgeClient.connect({ port: session.port, timeoutMs: 5000 });
    hello = client.hello as unknown as Record<string, unknown>;
    live = await client.call<Record<string, unknown>>('status');
    client.close();
  } catch (error) {
    connectError = (error as Error).message;
  }

  if (global.json) {
    printJson({ running: true, session, hello, status: live, connectError });
    return;
  }

  line(connectError === null ? 'Running.' : 'Running, but not answering yet.');
  keyValues([
    ['project', session.projectDir],
    ['loader', session.loader],
    ['minecraft', String(hello?.['mcVersion'] ?? session.mcVersion)],
    ['mod version', String(hello?.['clientDevBridgeVersion'] ?? session.bridgeVersion)],
    ['protocol', String(hello?.['protocol'] ?? '-')],
    ['port', session.port],
    ['pid', session.pid],
    ['display', session.display],
    ['uptime', formatDuration(Date.now() - new Date(session.startedAt).getTime())],
    ['gradle log', session.projectDir === '' ? '-' : path.join(session.projectDir, '.clientdevbridge', 'gradle.log')],
  ]);

  if (live !== null) {
    line('');
    keyValues([
      ['in world', String(live['inWorld'])],
      ['screen', String(live['screenClass'] ?? 'none')],
      ['tick', String(live['tick'])],
      ['fps', String(live['fps'])],
      ['gui size', `${live['guiWidth']}x${live['guiHeight']} @ scale ${live['guiScale']}`],
      ['pixel size', `${live['pixelWidth']}x${live['pixelHeight']}`],
      ['game dir', String(live['gameDir'] ?? '-')],
    ]);
  } else if (connectError !== null) {
    line('');
    line(connectError);
    line(`See ${path.join(session.projectDir, '.clientdevbridge', 'gradle.log')} for the game log.`);
  }
}

export async function runRestart(global: GlobalOptions, options: StartCommandOptions): Promise<void> {
  await stop(global.project);
  await runStart(global, options);
}

export const START_DEFAULTS = {
  port: String(DEFAULT_PORT),
  timeout: '300',
  width: String(DEFAULT_WIDTH),
  height: String(DEFAULT_HEIGHT),
};
