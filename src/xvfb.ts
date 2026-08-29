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
