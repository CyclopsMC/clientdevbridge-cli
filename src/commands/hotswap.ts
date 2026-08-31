import { detectProject } from '../detect.js';
import { CliError } from '../errors.js';
import {
  detectJetBrainsRuntime,
  diffClasses,
  gradleCompile,
  readPreviousSnapshot,
  redefineClasses,
  scanClasses,
  writeSnapshot,
} from '../hotswap.js';
import { line, printJson } from '../output.js';
import { requireRunningSession, type Session } from '../session.js';
import { runRestart, START_DEFAULTS, type StartCommandOptions } from './lifecycle.js';
import type { GlobalOptions } from './context.js';

export interface HotswapOptions {
  readonly compile: boolean;
  readonly baseline: boolean;
  readonly restartIfNeeded: boolean;
}

/**
 * Rebuilds the start options for a client that is already running.
 *
 * A restart that forgets the window size or the debug port is not the same client, and the caller
 * asked for their change to be live -- not for a differently configured client. Everything the
 * session records is reused; the rest falls back to the same defaults `start` would apply.
 */
function relaunchOptions(session: Session): StartCommandOptions {
  const launch = session.launch;
  return {
    loader: session.loader,
    mcVersion: session.mcVersion,
    clientdevbridgeVersion: session.bridgeVersion,
    world: session.world ?? undefined,
    headed: session.headed,
    // The entry was written, or refused, when the client first started; either way the answer for
    // a relaunch of that same client is that there is nothing left to write.
    gitignore: false,
    port: String(session.port),
    timeout: String(Math.round((launch?.timeoutMs ?? 300_000) / 1000)),
    gradleArgs: launch === undefined || launch.gradleArgs.length === 0 ? undefined : launch.gradleArgs.join(' '),
    width: String(launch?.width ?? Number(START_DEFAULTS.width)),
    height: String(launch?.height ?? Number(START_DEFAULTS.height)),
    eval: launch?.evalEnabled ?? true,
    pinOptions: launch?.pinOptions ?? true,
    jdwpPort: session.jdwpPort === null ? undefined : String(session.jdwpPort),
  };
}

export async function runHotswap(global: GlobalOptions, options: HotswapOptions): Promise<void> {
  const { session, paths } = requireRunningSession(global.project);
  const project = detectProject(global.project, { loader: session.loader, minecraftVersion: session.mcVersion });

  if (options.baseline) {
    writeSnapshot(paths.hotswapState, scanClasses(project.projectDir));
    line('Recorded the current classes as the hotswap baseline; nothing was swapped.');
    return;
  }

  if (session.jdwpPort === null) {
    throw new CliError(
      'This client was started without a debug port, so its classes cannot be redefined.',
      2,
      'Restart with: clientdevbridge restart --jdwp-port 5005',
    );
  }

  if (options.compile) {
    if (!global.quiet) {
      line('Compiling...');
    }
    gradleCompile(project.projectDir, project.gradleWrapper, project.javaVersion);
  }

  const current = scanClasses(project.projectDir);
  const previous = readPreviousSnapshot(paths.hotswapState);
  const { changed, added } = diffClasses(previous, current);

  if (previous === null) {
    writeSnapshot(paths.hotswapState, current);
    line(
      `No hotswap baseline existed, so ${current.size} classes were recorded as the baseline and nothing was swapped.`,
    );
    line('Edit your code, then run hotswap again.');
    return;
  }

  if (changed.length === 0) {
    writeSnapshot(paths.hotswapState, current);
    if (global.json) {
      printJson({ swapped: [], failed: [], pending: [], added, needsRestart: false });
      return;
    }
    line(`Nothing changed since the last hotswap${added.length === 0 ? '' : ` (${added.length} new classes)`}.`);
    return;
  }

  const result = redefineClasses(session.jdwpPort, changed);
  writeSnapshot(paths.hotswapState, current);

  if (global.json) {
    printJson({ ...result, added });
    return;
  }

  for (const name of result.swapped) {
    line(`swapped  ${name}`);
  }
  for (const failure of result.failed) {
    line(`FAILED   ${failure.name}: ${failure.reason}`);
  }
  for (const name of result.pending) {
    line(`pending  ${name} (not loaded yet; the new code is used the first time it is)`);
  }
  if (added.length > 0) {
    line(`# ${added.length} new class${added.length === 1 ? '' : 'es'} will be picked up on first use`);
  }
  if (result.swapped.length > 0 && !result.needsRestart) {
    line('');
    line(`Swapped ${result.swapped.length} class${result.swapped.length === 1 ? '' : 'es'} into the running client.`);
  }

  if (result.needsRestart) {
    line('');
    line('Some classes could not be redefined in place. HotSpot can only replace method bodies:');
    line('adding or removing a field, a method, or a superclass needs a full restart.');
    if (options.restartIfNeeded) {
      // The whole point of --restart-if-needed: whether an edit is swappable depends on HotSpot's
      // redefinition rules, and a caller that just wants their change live should not have to
      // know them. The compile has already happened, so the restart picks up the new code.
      line('Restarting, because --restart-if-needed was given.');
      await runRestart(global, relaunchOptions(session));
      line('');
      line('The client was restarted, so the world and anything built in it are gone.');
      return;
    }
    line('Run: clientdevbridge restart  (or pass --restart-if-needed to do it automatically)');
    if (!detectJetBrainsRuntime()) {
      line('');
      line('The JetBrains Runtime supports much more extensive redefinition (adding methods and');
      line('fields). Pointing JAVA_HOME at a JBR install makes more of these swaps succeed.');
    }
    process.exitCode = 1;
  }
}
