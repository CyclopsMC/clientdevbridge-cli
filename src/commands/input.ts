import { line, printJson, warn } from '../output.js';
import { CliError } from '../errors.js';
import { type GlobalOptions, withClient } from './context.js';
import type { BridgeClient } from '../protocol/client.js';

export function parsePoint(raw: string, what: string): { x: number; y: number } {
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((value) => Number.isNaN(value))) {
    throw new CliError(`${what} must be two numbers 'x,y', but was '${raw}'.`, 1, `For example: ${what} 210,100`);
  }
  return { x: parts[0] as number, y: parts[1] as number };
}

/**
 * Every state-changing input command reports the screen it left behind, so an agent can tell at a
 * glance whether its click did anything.
 */
async function reportAfterInput(global: GlobalOptions, result: Record<string, unknown>): Promise<void> {
  if (global.json) {
    printJson(result);
    return;
  }
  if (!global.quiet) {
    line(`screen: ${result['screenClass'] ?? 'none'}`);
  }
}

export async function runClick(
  global: GlobalOptions,
  options: { at?: string | undefined; widget?: string | undefined; button: string; space: string },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    let point: { x: number; y: number };
    if (options.widget !== undefined) {
      const { resolveWidget } = await import('./snapshot.js');
      point = await resolveWidget(client, options.widget);
    } else if (options.at !== undefined) {
      point = parsePoint(options.at, '--at');
    } else {
      throw new CliError('click needs either --at x,y or --widget <text-or-path>.', 1);
    }
    const result = await client.call<Record<string, unknown>>('input.mouseClick', {
      ...point,
      button: Number(options.button),
      space: options.space,
    });
    await reportAfterInput(global, result);
  });
}

export async function runType(global: GlobalOptions, text: string): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>('input.type', { text });
    await reportAfterInput(global, result);
  });
}

/**
 * Replaces the contents of a text field, the way a player would.
 *
 * The manual version of this is click, press BACKSPACE as many times as the old value is long,
 * type, then trigger whatever commits it -- four to eight commands, with a backspace count that is
 * a guess unless you snapshot first. The snapshot already carries the field's current value, so
 * the count is known exactly and none of it needs to be a guess.
 *
 * Everything goes through real input rather than setting the value on the widget: a field's own
 * key handling is where mods put their filtering and their save-on-commit, and a value written
 * past it is a value the screen never agreed to.
 */
export async function runSetText(
  global: GlobalOptions,
  widget: string,
  value: string,
  options: { commit: string },
): Promise<void> {
  const commit = options.commit.toLowerCase();
  if (!['enter', 'tab', 'none'].includes(commit)) {
    throw new CliError(`--commit must be enter, tab or none, but was '${options.commit}'.`, 1);
  }

  await withClient(global, async ({ client }) => {
    const { findWidget } = await import('./snapshot.js');
    const node = await findWidget(client, widget);
    const before = typeof node.value === 'string' ? node.value : '';
    if (node.extra['kind'] !== 'editBox') {
      throw new CliError(
        `${node.path} is a ${node.type.split('.').pop() ?? node.type}, not a text field.`,
        1,
        'set-text only works on an edit box; `clientdevbridge snapshot` marks them with kind=editBox.',
      );
    }
    if (node.bounds === null) {
      throw new CliError(`${node.path} reports no bounds, so there is nowhere to click.`, 1);
    }

    await client.call('input.mouseClick', {
      x: node.bounds.x + node.bounds.w / 2,
      y: node.bounds.y + node.bounds.h / 2,
      button: 0,
      space: 'gui',
    });
    // END first: the click put the cursor wherever it landed, and backspacing from the middle
    // would leave the tail of the old value behind.
    await client.call('input.key', { key: 'END', action: 'tap' });
    for (let index = 0; index < before.length; index++) {
      await client.call('input.key', { key: 'BACKSPACE', action: 'tap' });
    }
    if (value !== '') {
      await client.call('input.type', { text: value });
    }
    if (commit !== 'none') {
      await client.call('input.key', { key: commit.toUpperCase(), action: 'tap' });
    }

    // Read it back rather than trusting the writes: a field that rejects a character silently
    // ends up holding something other than what was asked for, and that is worth knowing here
    // rather than three commands later.
    const after = await readValue(client, node.path);
    if (global.json) {
      printJson({ path: node.path, before, requested: value, value: after, commit });
      return;
    }
    if (after !== value) {
      warn(`${node.path} holds '${after ?? ''}' rather than '${value}'; the field rejected part of it.`);
    }
    if (!global.quiet) {
      line(`${node.path}: '${before}' -> '${after ?? ''}'`);
    }
  });
}

/** Re-reads one widget's value after an edit, or null if it has gone from the screen. */
async function readValue(client: BridgeClient, path: string): Promise<string | null> {
  const { findNodeByPath } = await import('./snapshot.js');
  const node = await findNodeByPath(client, path);
  if (node === undefined) {
    return null;
  }
  return typeof node.value === 'string' ? node.value : null;
}

export async function runKey(
  global: GlobalOptions,
  key: string,
  options: { action: string; modifiers?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = { key, action: options.action };
    if (options.modifiers !== undefined) {
      params['modifiers'] = Number(options.modifiers);
    }
    const result = await client.call<Record<string, unknown>>('input.key', params);
    await reportAfterInput(global, result);
  });
}

export async function runHoldKey(global: GlobalOptions, key: string, options: { ticks: string }): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>(
      'input.hold',
      { key, ticks: Number(options.ticks) },
      120_000,
    );
    await reportAfterInput(global, result);
  });
}

export async function runMouseMove(global: GlobalOptions, at: string, options: { space: string }): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>('input.mouseMove', {
      ...parsePoint(at, 'mouse-move'),
      space: options.space,
    });
    await reportAfterInput(global, result);
  });
}

export async function runScroll(
  global: GlobalOptions,
  options: { at: string; dy: string; dx: string; space: string },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>('input.scroll', {
      ...parsePoint(options.at, '--at'),
      dx: Number(options.dx),
      dy: Number(options.dy),
      space: options.space,
    });
    await reportAfterInput(global, result);
  });
}

export async function runDrag(
  global: GlobalOptions,
  options: { from: string; to: string; button: string; steps: string; space: string },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const from = parsePoint(options.from, '--from');
    const to = parsePoint(options.to, '--to');
    const result = await client.call<Record<string, unknown>>('input.mouseDrag', {
      from: [from.x, from.y],
      to: [to.x, to.y],
      button: Number(options.button),
      steps: Number(options.steps),
      space: options.space,
    });
    await reportAfterInput(global, result);
  });
}

/** The faces a block has, for `--face`. */
const FACES = ['down', 'up', 'north', 'south', 'east', 'west'] as const;

export interface AimOptions {
  readonly face?: string | undefined;
  readonly at?: string | undefined;
}

/**
 * Turns `--face`/`--at` into the aim the protocol takes.
 *
 * Most blocks read the hit result they are handed and behave the same whichever face it names, so
 * aiming stays optional. Multipart blocks -- a cable with parts on its sides -- do not: they work
 * out what was clicked by casting a ray from the player's eye, so the side has to be said out loud
 * or the click lands on whichever part happens to be in the way.
 */
export function aimParams(options: AimOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options.face !== undefined) {
    const face = options.face.toLowerCase();
    if (!(FACES as readonly string[]).includes(face)) {
      throw new CliError(`'${options.face}' is not a face.`, 2, `Use one of: ${FACES.join(', ')}.`);
    }
    params['face'] = face;
  }
  if (options.at !== undefined) {
    const parts = options.at.split(',').map((value) => Number(value.trim()));
    if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
      throw new CliError(`--at expects 'x,y,z', got '${options.at}'.`, 2,
        'The point is in world coordinates, so a face centre looks like 0.5,5,2.5.');
    }
    params['at'] = parts;
  }
  return params;
}

export async function runOpenGui(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { approach: boolean } & AimOptions,
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>(
      'screen.open',
      { blockPos: [Number(x), Number(y), Number(z)], approach: options.approach, ...aimParams(options) },
      60_000,
    );
    if (global.json) {
      printJson(result);
      return;
    }
    if (result['opened'] === true) {
      line(`screen: ${result['screenClass']}`);
    } else {
      line(`No screen opened. ${result['hint'] ?? ''}`.trim());
      process.exitCode = 1;
    }
  });
}

export async function runCloseScreen(global: GlobalOptions): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>('screen.close');
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      line('Closed the screen.');
    }
  });
}

export async function runEval(global: GlobalOptions, code: string): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>('eval', { language: 'groovy', code }, 60_000);
    if (global.json) {
      printJson(result);
      return;
    }
    const stdout = String(result['stdout'] ?? '');
    if (stdout.length > 0) {
      process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
    }
    // The mod describes anything it cannot map to JSON as { type, toString }. Every JS object
    // inherits a toString, so this has to check for that exact shape rather than for the key.
    const value = result['value'];
    if (isDescribedObject(value)) {
      line(value['toString']);
    } else {
      line(JSON.stringify(value));
    }
  });
}

export function isDescribedObject(value: unknown): value is { type: string; toString: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['type'] === 'string' &&
    typeof (value as Record<string, unknown>)['toString'] === 'string'
  );
}

export async function runWaitFor(
  global: GlobalOptions,
  options: {
    ticks?: string | undefined;
    screen?: string | undefined;
    expr?: string | undefined;
    inWorld?: boolean | undefined;
    chunk?: string | undefined;
    timeout: string;
  },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const timeoutMs = Number(options.timeout);

    if (options.ticks !== undefined) {
      const result = await client.call<Record<string, unknown>>('wait.ticks', { ticks: Number(options.ticks) }, timeoutMs + 30_000);
      if (global.json) {
        printJson(result);
      } else if (!global.quiet) {
        line(`Waited ${options.ticks} ticks (now at tick ${result['tick']}).`);
      }
      return;
    }

    let params: Record<string, unknown>;
    if (options.screen !== undefined) {
      params = { condition: 'screen', value: options.screen, timeoutMs };
    } else if (options.expr !== undefined) {
      params = { condition: 'expr', value: options.expr, timeoutMs };
    } else if (options.chunk !== undefined) {
      params = { condition: 'chunkLoaded', value: options.chunk.split(',').map(Number), timeoutMs };
    } else if (options.inWorld === true) {
      params = { condition: 'inWorld', timeoutMs };
    } else {
      throw new CliError('wait needs one of --ticks, --screen, --expr, --chunk or --in-world.', 1);
    }

    const result = await client.call<Record<string, unknown>>('wait.for', params, timeoutMs + 30_000);
    if (global.json) {
      printJson(result);
      return;
    }
    if (result['met'] === true) {
      if (!global.quiet) {
        line(`Condition met (screen: ${result['screenClass'] ?? 'none'}, in world: ${result['inWorld']}).`);
      }
    } else {
      line(
        `Timed out after ${timeoutMs} ms waiting for ${result['condition']}` +
          ` (screen is ${result['screenClass'] ?? 'none'}, in world: ${result['inWorld']}).`,
      );
      process.exitCode = 1;
    }
  });
}
