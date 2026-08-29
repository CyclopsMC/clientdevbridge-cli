import { line, printJson } from '../output.js';
import { CliError } from '../errors.js';
import { type GlobalOptions, withClient } from './context.js';

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

export async function runOpenGui(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { approach: boolean },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>(
      'screen.open',
      { blockPos: [Number(x), Number(y), Number(z)], approach: options.approach },
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
