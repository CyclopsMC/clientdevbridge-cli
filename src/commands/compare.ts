import * as fs from 'node:fs';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { CliError } from '../errors.js';
import { line, printJson, printPath } from '../output.js';
import { type GlobalOptions, withClient } from './context.js';
import { parseRegion } from './inspect.js';

export interface CompareOptions {
  readonly region?: string | undefined;
  readonly space: string;
  readonly threshold: string;
  readonly pixelThreshold: string;
  readonly update: boolean;
  readonly afterTicks?: string | undefined;
  readonly renderer?: string | undefined;
}

/**
 * Golden images are keyed by renderer.
 *
 * Software rasterisation and a real GPU do not produce identical pixels — different texture
 * filtering, different rounding — and no single tolerance covers both without also hiding real
 * regressions. Keeping a set per renderer means each one can be compared strictly.
 */
export function goldenPathFor(goldenDir: string, name: string, renderer: string): string {
  return path.join(goldenDir, renderer, `${name}.png`);
}

/** Normalises a GL_RENDERER string into a short, stable directory name. */
export function rendererKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.length === 0) {
    return 'unknown';
  }
  const lowered = raw.toLowerCase();
  if (lowered.includes('llvmpipe') || lowered.includes('softpipe') || lowered.includes('swrast')) {
    return 'llvmpipe';
  }
  return 'gpu';
}

export async function runCompare(global: GlobalOptions, name: string, options: CompareOptions): Promise<void> {
  await withClient(global, async ({ client, paths }) => {
    const params: Record<string, unknown> = {};
    if (options.region !== undefined) {
      params['region'] = parseRegion(options.region, options.space);
    }
    if (options.afterTicks !== undefined) {
      params['afterTicks'] = Number(options.afterTicks);
    }

    const shot = await client.call<Record<string, unknown>>('screenshot', params);
    const actualPng = Buffer.from(String(shot['png']), 'base64');

    const renderer = options.renderer ?? rendererKey(await readRenderer(client));
    const goldenPath = goldenPathFor(paths.golden, name, renderer);

    if (options.update) {
      fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
      fs.writeFileSync(goldenPath, actualPng);
      if (global.json) {
        printJson({ updated: true, golden: goldenPath, renderer });
        return;
      }
      line(`Wrote the golden image for '${name}' (renderer ${renderer}).`);
      printPath(path.resolve(goldenPath));
      return;
    }

    if (!fs.existsSync(goldenPath)) {
      throw new CliError(
        `There is no golden image for '${name}' at ${goldenPath}.`,
        1,
        `Create it with: clientdevbridge compare ${name} --update`,
      );
    }

    const golden = PNG.sync.read(fs.readFileSync(goldenPath));
    const actual = PNG.sync.read(actualPng);

    if (golden.width !== actual.width || golden.height !== actual.height) {
      const actualPath = path.join(paths.diffs, `${name}-actual.png`);
      fs.mkdirSync(paths.diffs, { recursive: true });
      fs.writeFileSync(actualPath, actualPng);
      if (global.json) {
        printJson({
          match: false,
          reason: 'size',
          golden: { width: golden.width, height: golden.height },
          actual: { width: actual.width, height: actual.height },
          actualPath,
        });
      } else {
        line(
          `Size mismatch: the golden image is ${golden.width}x${golden.height} but the screenshot is ` +
            `${actual.width}x${actual.height}.`,
        );
        line('Pin the window with `clientdevbridge resize` before comparing, or re-record with --update.');
        printPath(path.resolve(actualPath));
      }
      process.exitCode = 1;
      return;
    }

    const diff = new PNG({ width: golden.width, height: golden.height });
    const pixelsDiff = pixelmatch(golden.data, actual.data, diff.data, golden.width, golden.height, {
      threshold: Number(options.pixelThreshold),
    });
    const total = golden.width * golden.height;
    const percentage = (pixelsDiff / total) * 100;
    const allowed = Number(options.threshold);
    const match = percentage <= allowed;

    let diffPath: string | null = null;
    if (!match) {
      fs.mkdirSync(paths.diffs, { recursive: true });
      diffPath = path.join(paths.diffs, `${name}-diff.png`);
      fs.writeFileSync(diffPath, PNG.sync.write(diff));
      fs.writeFileSync(path.join(paths.diffs, `${name}-actual.png`), actualPng);
    }

    if (global.json) {
      printJson({ match, pixelsDiff, pct: percentage, threshold: allowed, renderer, golden: goldenPath, diffPath });
    } else if (match) {
      line(`${name}: matches (${pixelsDiff} of ${total} pixels differ, ${percentage.toFixed(3)}% <= ${allowed}%).`);
    } else {
      line(
        `${name}: DIFFERS — ${pixelsDiff} of ${total} pixels, ${percentage.toFixed(3)}% > ${allowed}%.` +
          ` Golden: ${goldenPath}`,
      );
      printPath(path.resolve(diffPath as string));
      if (!global.quiet) {
        line(
          'If the diff is concentrated on an animated block (lava, fire, water, a portal) or on a ' +
            'toast popup, that is frame-to-frame animation rather than a regression: raise ' +
            '--threshold, or pass --region to compare only the part that should hold still.',
        );
      }
    }
    if (!match) {
      process.exitCode = 1;
    }
  });
}

/**
 * Asks the game which GL renderer it is on, so golden sets can be kept apart.
 * Falls back to 'unknown' rather than failing: a missing renderer name is not worth an error.
 */
async function readRenderer(client: { call: <T>(m: string, p?: Record<string, unknown>) => Promise<T> }): Promise<string | null> {
  try {
    const result = await client.call<Record<string, unknown>>('status');
    const renderer = result['glRenderer'];
    return typeof renderer === 'string' ? renderer : null;
  } catch {
    return null;
  }
}

export async function runResize(
  global: GlobalOptions,
  options: { width: string; height: string; guiScale?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = { width: Number(options.width), height: Number(options.height) };
    if (options.guiScale !== undefined) {
      params['guiScale'] = Number(options.guiScale);
    }
    const result = await client.call<Record<string, unknown>>('window.resize', params);
    if (global.json) {
      printJson(result);
      return;
    }
    line(
      `window ${result['pixelWidth']}x${result['pixelHeight']}px, ` +
        `gui ${result['guiWidth']}x${result['guiHeight']} @ scale ${result['guiScale']}`,
    );
  });
}
