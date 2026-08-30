import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import { line, printJson, printPath } from '../output.js';
import { readTruncated, tailFile } from '../launcher.js';
import { readSession } from '../session.js';
import { type GlobalOptions, timestampName, withClient, writeBase64 } from './context.js';
import { CliError } from '../errors.js';
import { diffImages } from './compare.js';

export interface ScreenshotOptions {
  readonly name?: string | undefined;
  readonly region?: string | undefined;
  readonly afterTicks?: string | undefined;
  readonly scale?: string | undefined;
  readonly space?: string | undefined;
  readonly diff?: string | undefined;
  readonly minDiff?: string | undefined;
  readonly pixelThreshold?: string | undefined;
}

export function parseRegion(raw: string, space: string): Record<string, unknown> {
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) {
    throw new CliError(
      `--region must be four numbers 'x,y,w,h', but was '${raw}'.`,
      1,
      'For example: --region 100,80,200,120',
    );
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3], space };
}

export async function runScreenshot(global: GlobalOptions, options: ScreenshotOptions): Promise<void> {
  await withClient(global, async ({ client, paths }) => {
    const space = options.space ?? 'gui';
    const params: Record<string, unknown> = {};
    if (options.region !== undefined) {
      params['region'] = parseRegion(options.region, space);
    }
    if (options.afterTicks !== undefined) {
      params['afterTicks'] = Number(options.afterTicks);
    }
    if (options.scale !== undefined) {
      params['scale'] = Number(options.scale);
    }

    const result = await client.call<Record<string, unknown>>('screenshot', params);
    const file = writeBase64(paths.screenshots, options.name ?? timestampName('screenshot'), String(result['png']));

    if (global.json) {
      const { png: _png, ...rest } = result;
      printJson({ ...rest, path: file });
      return;
    }
    if (!global.quiet) {
      line(
        `${result['width']}x${result['height']} px  (window ${result['pixelWidth']}x${result['pixelHeight']}, ` +
          `gui ${result['guiWidth']}x${result['guiHeight']} @ scale ${result['guiScale']})`,
      );
    }
    // The path goes on its own line: this is the contract an agent reads to open the image.
    printPath(file);

    if (options.diff !== undefined) {
      reportDifference(global, paths.diffs, file, options);
    }
  });
}

/**
 * Answers "did this visibly do anything" against an earlier capture.
 *
 * This is `compare` turned around. `compare` asserts a screen has not changed against a committed
 * golden; here the caller has just done something and wants a machine-checkable answer that it
 * showed up on screen. Proving a redstone lamp went on and off used to mean taking two
 * screenshots and looking at them, which is an answer a person can read and a script cannot.
 *
 * Failing means "too similar", so the exit code carries the assertion.
 */
function reportDifference(
  global: GlobalOptions,
  diffsDir: string,
  file: string,
  options: ScreenshotOptions,
): void {
  const other = options.diff as string;
  if (!fs.existsSync(other)) {
    throw new CliError(`No such image to diff against: ${other}`, 1,
      'Pass the path a previous `clientdevbridge screenshot` printed.');
  }

  const before = PNG.sync.read(fs.readFileSync(other));
  const after = PNG.sync.read(fs.readFileSync(file));
  if (before.width !== after.width || before.height !== after.height) {
    throw new CliError(
      `${path.basename(other)} is ${before.width}x${before.height} but this capture is ` +
        `${after.width}x${after.height}, so they cannot be compared.`,
      1,
      'Pin the window with `clientdevbridge resize` before capturing either one.',
    );
  }

  const minimum = Number(options.minDiff ?? '0.1');
  const { diff, pixelsDiff, total, percentage } = diffImages(before, after, Number(options.pixelThreshold ?? '0.1'));
  const changed = percentage >= minimum;

  let diffPath: string | null = null;
  if (!changed) {
    // Written only on failure, and only then: when the images do differ the caller has both
    // captures already and a third file is noise.
    fs.mkdirSync(diffsDir, { recursive: true });
    diffPath = path.join(diffsDir, `${path.basename(file, '.png')}-vs-${path.basename(other, '.png')}.png`);
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
  }

  if (global.json) {
    printJson({ changed, pixelsDiff, pct: percentage, minDiff: minimum, against: path.resolve(other), diffPath });
  } else if (changed) {
    line(`changed: ${pixelsDiff} of ${total} pixels, ${percentage.toFixed(3)}% >= ${minimum}%.`);
  } else {
    line(
      `UNCHANGED against ${path.basename(other)}: ${pixelsDiff} of ${total} pixels, ` +
        `${percentage.toFixed(3)}% < ${minimum}%.`,
    );
    printPath(path.resolve(diffPath as string));
  }
  if (!changed) {
    process.exitCode = 1;
  }
}

export interface LogsOptions {
  readonly lines: string;
  readonly filter?: string | undefined;
  readonly level?: string | undefined;
  readonly gradle: boolean;
}

export async function runLogs(global: GlobalOptions, options: LogsOptions): Promise<void> {
  const count = Number(options.lines);

  if (options.gradle) {
    const status = readSession(global.project);
    const file = status.paths.gradleLog;
    let text = tailFile(file, count);
    if (options.filter !== undefined) {
      const pattern = new RegExp(options.filter);
      text = readTruncated(file)
        .split('\n')
        .filter((entry) => pattern.test(entry))
        .slice(-count)
        .join('\n');
    }
    if (global.json) {
      printJson({ source: file, lines: text.split('\n').filter((entry) => entry.length > 0) });
      return;
    }
    if (!global.quiet) {
      line(`# ${file}`);
    }
    line(text);
    return;
  }

  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = { lines: count };
    if (options.filter !== undefined) {
      params['filter'] = options.filter;
    }
    if (options.level !== undefined) {
      params['level'] = options.level;
    }
    const result = await client.call<{ lines: string[]; buffered: number; level: string }>('log.tail', params);
    if (global.json) {
      printJson(result);
      return;
    }
    for (const entry of result.lines) {
      line(entry);
    }
    if (!global.quiet) {
      line(`# ${result.lines.length} of ${result.buffered} buffered lines, at level ${result.level} and above`);
    }
  });
}

export function screenshotDirectory(projectDir: string): string {
  return path.join(projectDir, '.clientdevbridge', 'screenshots');
}
