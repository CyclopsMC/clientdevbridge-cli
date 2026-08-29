import * as path from 'node:path';
import {
  DEFAULT_HEIGHT,
  DEFAULT_PORT,
  DEFAULT_USERNAME,
  DEFAULT_WIDTH,
  describePortOwner,
  isPortFree,
  start,
  stop,
  tailFile,
} from '../launcher.js';
import { formatDuration, keyValues, line, printJson } from '../output.js';
import { readSession } from '../session.js';
import { BridgeClient } from '../protocol/client.js';
import type { Loader } from '../detect.js';
import type { GlobalOptions } from './context.js';

export interface StartCommandOptions {
  readonly loader?: string | undefined;
  readonly mcVersion?: string | undefined;
  readonly clientdevbridgeVersion?: string | undefined;
  readonly world?: string | undefined;
  readonly headed: boolean;
  readonly port: string;
  readonly timeout: string;
  readonly gradleArgs?: string | undefined;
  readonly width: string;
  readonly height: string;
  readonly eval: boolean;
  readonly pinOptions: boolean;
  readonly jdwpPort?: string | undefined;
}

export async function runStart(global: GlobalOptions, options: StartCommandOptions): Promise<void> {
  const result = await start({
    projectDir: global.project,
    loader: options.loader as Loader | undefined,
    minecraftVersion: options.mcVersion,
    bridgeVersion: options.clientdevbridgeVersion,
    world: options.world,
    headed: options.headed,
    port: Number(options.port),
    timeoutMs: Number(options.timeout) * 1000,
    gradleArgs: options.gradleArgs === undefined ? [] : options.gradleArgs.split(' ').filter((a) => a.length > 0),
    width: Number(options.width),
    height: Number(options.height),
    evalEnabled: options.eval,
    pinOptions: options.pinOptions,
    jdwpPort: options.jdwpPort === undefined ? null : Number(options.jdwpPort),
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
    ['mods', hello['mods'] as string[]],
  ]);
}

export async function runStop(global: GlobalOptions, options: { port?: string | undefined } = {}): Promise<void> {
  const result = await stop(global.project, options.port === undefined ? undefined : Number(options.port));
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
  if (result.orphan !== null) {
    line('');
    line(`But something is still listening on the bridge port: pid ${result.orphan}.`);
    line(`That is an orphaned client whose session file is gone. Stop it with: kill ${result.orphan.split(' ')[0]}`);
    process.exitCode = 2;
  }
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
    if (orphan !== null) {
      line('');
      line(`Something is still listening on port ${port}: pid ${orphan}.`);
      line('That is an orphaned client whose session file is gone. Either reattach by restoring the');
      line(`session, or stop it with: kill ${orphan.split(' ')[0]}`);
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
