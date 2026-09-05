import { execFileSync } from 'node:child_process';

export interface DisplayPlan {
  /** The command to run, which may be `xvfb-run` wrapping the real one. */
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly description: string;
}

export function commandExists(command: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides how to give the client a display.
 *
 * "Headless" here means a real client on a virtual display, not a client without rendering:
 * on Linux without `$DISPLAY` that is Xvfb plus Mesa's llvmpipe software rasteriser. Everywhere
 * else, and with `--headed`, the client just opens a window. Nothing else about the CLI's
 * behaviour differs between the two.
 */
export function planDisplay(
  command: string,
  options: { headed: boolean; width: number; height: number },
): DisplayPlan {
  const hasDisplay = (process.env['DISPLAY'] ?? '').length > 0;
  if (options.headed || hasDisplay || process.platform !== 'linux') {
    return {
      command,
      prefixArgs: [],
      env: {},
      description: options.headed
        ? 'headed (--headed)'
        : hasDisplay
          ? `existing display ${process.env['DISPLAY']}`
          : `native window on ${process.platform}`,
    };
  }

  if (!commandExists('xvfb-run')) {
    throw new Error(
      'No $DISPLAY is set and xvfb-run is not installed, so the client has nowhere to render.\n' +
        'Install it with: sudo apt-get install -y xvfb libgl1-mesa-dri\n' +
        'Or pass --headed if you do have a display available.',
    );
  }

  return {
    command: 'xvfb-run',
    // A generous virtual screen: the client window is smaller, but resizing beyond the
    // screen (window.resize) would otherwise silently clamp.
    prefixArgs: ['-a', '-s', `-screen 0 ${Math.max(options.width, 1280)}x${Math.max(options.height, 800)}x24`],
    env: { LIBGL_ALWAYS_SOFTWARE: '1' },
    description: 'xvfb-run with Mesa llvmpipe',
  };
}

/**
 * The pids of every Xvfb server currently running.
 *
 * `xvfb-run` picks a free display itself and never says which, so the only way to know what it
 * started is to look before and after. Anything that appears in between is what this launch is
 * responsible for cleaning up.
 */
export function xvfbPids(): number[] {
  try {
    return execFileSync('pgrep', ['-x', 'Xvfb'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // pgrep exits non-zero when nothing matches, and is absent on platforms that never use Xvfb.
    return [];
  }
}

/** The process group a pid belongs to, or null where that cannot be read. */
export function processGroupOf(pid: number): number | null {
  try {
    const group = Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
        encoding: 'utf8',
        // ps complains on stderr about a pid it cannot look up, and that complaint would surface
        // in the middle of a launch as if something had gone wrong. The empty result is the answer.
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
    return Number.isInteger(group) && group > 0 ? group : null;
  } catch {
    // No such process any more, or no ps: the caller has a weaker answer to fall back on.
    return null;
  }
}

/**
 * Which of the X servers that appeared during a launch belong to it.
 *
 * "Appeared while we were starting" is not the same as "ours" once two launches can overlap, and
 * they routinely do -- an agent per worktree, or a second client to compare against. Both are
 * waiting on a Gradle build for a minute or two before their `xvfb-run` starts anything, so each
 * sees the other's server appear inside its own window and writes it down as its own. The `stop`
 * that follows then kills a display belonging to a client somebody is still using.
 *
 * `xvfb-run` backgrounds Xvfb from a shell this process spawned into its own group, so the server
 * carries that group and the question has an exact answer. Where it cannot be asked -- no `ps`, a
 * server that exited in between -- the older, coarser answer is used rather than none: a leaked
 * Xvfb holds its display lock and makes the next run that lands on it die before it renders.
 */
export function xvfbPidsOfGroup(appeared: readonly number[], pgid: number): number[] {
  const ours = appeared.filter((pid) => processGroupOf(pid) === pgid);
  return ours.length > 0 ? ours : [...appeared];
}
