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
import { requireRunningSession } from '../session.js';
import type { GlobalOptions } from './context.js';

export interface HotswapOptions {
  readonly compile: boolean;
  readonly baseline: boolean;
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
    gradleCompile(project.projectDir, project.gradleWrapper);
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
    line('Run: clientdevbridge restart');
    if (!detectJetBrainsRuntime()) {
      line('');
      line('The JetBrains Runtime supports much more extensive redefinition (adding methods and');
      line('fields). Pointing JAVA_HOME at a JBR install makes more of these swaps succeed.');
    }
    process.exitCode = 1;
  }
}
