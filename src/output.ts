/**
 * Output conventions (plan §5), in one place so every command obeys them.
 *
 * - Default output is text meant to be read by a human or an agent; `--json` prints the raw
 *   protocol result instead.
 * - Images are never printed. A screenshot writes a file and prints its absolute path on its
 *   own line, so an agent can hand that path straight to a file-reading tool.
 */
export interface OutputOptions {
  readonly json: boolean;
  readonly quiet: boolean;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** Prints a path on its own line, which is the contract for every file the CLI produces. */
export function printPath(absolutePath: string): void {
  process.stdout.write(`${absolutePath}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`warning: ${text}\n`);
}

export function keyValues(entries: readonly (readonly [string, unknown])[]): void {
  const width = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    line(`${key.padEnd(width)}  ${formatValue(value)}`);
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '-' : value.join(', ');
  }
  return String(value);
}

/** Renders a duration the way a person reads it, for `status`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
