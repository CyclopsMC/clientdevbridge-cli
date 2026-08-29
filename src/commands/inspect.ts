import * as path from 'node:path';
import { line, printJson, printPath } from '../output.js';
import { readTruncated, tailFile } from '../launcher.js';
import { readSession } from '../session.js';
import { type GlobalOptions, timestampName, withClient, writeBase64 } from './context.js';
import { CliError } from '../errors.js';

export interface ScreenshotOptions {
  readonly name?: string | undefined;
  readonly region?: string | undefined;
  readonly afterTicks?: string | undefined;
  readonly scale?: string | undefined;
  readonly space?: string | undefined;
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
  });
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

export async function runWait(
  global: GlobalOptions,
  options: { ticks?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const ticks = Number(options.ticks ?? '1');
    const result = await client.call<Record<string, unknown>>('wait.ticks', { ticks });
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      line(`Waited ${ticks} tick${ticks === 1 ? '' : 's'} (now at tick ${result['tick']}).`);
    }
  });
}

export function screenshotDirectory(projectDir: string): string {
  return path.join(projectDir, '.clientdevbridge', 'screenshots');
}
