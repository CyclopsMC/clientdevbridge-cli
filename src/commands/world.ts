import { line, printJson } from '../output.js';
import { type GlobalOptions, withClient } from './context.js';
import { CliError, EXIT_PROTOCOL } from '../errors.js';

export interface WorldResetOptions {
  readonly name?: string | undefined;
  readonly template?: string | undefined;
  readonly setup?: string | undefined;
}

export async function runWorldReset(global: GlobalOptions, options: WorldResetOptions): Promise<void> {
  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = {};
    if (options.name !== undefined) {
      params['name'] = options.name;
    }
    if (options.template !== undefined) {
      params['template'] = options.template;
    }
    if (options.setup !== undefined) {
      params['setup'] = options.setup;
    }
    // Generating and joining a world under software rendering is slow; give it its own budget.
    const result = await client.call<Record<string, unknown>>('world.reset', params, 180_000);
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      const spawn = result['spawn'] as number[];
      line(
        `World '${result['world']}' is ready` +
          `${result['template'] === null ? ' (fresh creative superflat)' : ` (from template ${result['template']})`}` +
          `, player at ${spawn.join(', ')}.`,
      );
    }
  });
}

export async function runWorldLoad(global: GlobalOptions, name: string): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<Record<string, unknown>>('world.load', { name }, 180_000);
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      line(`Loaded world '${result['world']}'.`);
    }
  });
}

export async function runWorldLeave(global: GlobalOptions): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call('world.leave', {}, 60_000);
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      line('Left the world.');
    }
  });
}

export async function runWorldList(global: GlobalOptions): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<{ worlds: string[] }>('world.list');
    if (global.json) {
      printJson(result);
      return;
    }
    if (result.worlds.length === 0) {
      line('No worlds yet. Create one with: clientdevbridge world-reset');
      return;
    }
    for (const world of result.worlds) {
      line(world);
    }
  });
}

export async function runCommand(global: GlobalOptions, command: string): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<{ output: string[]; success: boolean }>(
      'world.command',
      { command },
      60_000,
    );
    if (global.json) {
      printJson(result);
    } else if (result.output.length === 0) {
      if (!global.quiet) {
        line(result.success ? '(the command produced no output)' : '(the command failed with no output)');
      }
    } else {
      for (const entry of result.output) {
        line(entry);
      }
    }

    // A failing command still prints something, so without this a scripted setup would sail past
    // a scene that was never built and leave the caller debugging a phantom.
    if (!result.success) {
      process.exitCode = EXIT_PROTOCOL;
    }
  });
}

function parsePosition(x: string, y: string, z: string): { x: number; y: number; z: number } {
  const parsed = { x: Number(x), y: Number(y), z: Number(z) };
  if (Number.isNaN(parsed.x) || Number.isNaN(parsed.y) || Number.isNaN(parsed.z)) {
    throw new CliError(`Expected three numbers for a block position, but got '${x} ${y} ${z}'.`, 1);
  }
  return parsed;
}

export async function runBlock(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { nbt: boolean },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const position = parsePosition(x, y, z);
    const result = await client.call<Record<string, unknown>>('world.block', { ...position, nbt: options.nbt });
    if (global.json) {
      printJson(result);
      return;
    }
    line(String(result['state']));
    const blockEntity = result['blockEntity'] as Record<string, unknown> | null;
    if (blockEntity !== null) {
      line(`block entity: ${blockEntity['type']}`);
      if (blockEntity['nbt'] !== undefined) {
        line(String(blockEntity['nbt']));
      }
    }
  });
}

export async function runSetblock(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  block: string,
): Promise<void> {
  const position = parsePosition(x, y, z);
  await runCommand(global, `setblock ${position.x} ${position.y} ${position.z} ${block}`);
}

export async function runGive(global: GlobalOptions, item: string, count: string): Promise<void> {
  await runCommand(global, `give @s ${item} ${count}`);
}

export async function runTeleport(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { yaw?: string | undefined; pitch?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const position = parsePosition(x, y, z);
    const params: Record<string, unknown> = { ...position };
    if (options.yaw !== undefined) {
      params['yaw'] = Number(options.yaw);
    }
    if (options.pitch !== undefined) {
      params['pitch'] = Number(options.pitch);
    }
    const result = await client.call<Record<string, unknown>>('player.teleport', params);
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      const pos = result['pos'] as number[];
      line(`Player at ${pos.map((value) => value.toFixed(2)).join(', ')}, facing ${result['yaw']}/${result['pitch']}.`);
    }
  });
}

export async function runLook(
  global: GlobalOptions,
  options: { at?: string | undefined; yaw?: string | undefined; pitch?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = {};
    if (options.at !== undefined) {
      const parts = options.at.split(',').map((part) => Number(part.trim()));
      if (parts.length !== 3 || parts.some((value) => Number.isNaN(value))) {
        throw new CliError(`--at must be 'x,y,z', but was '${options.at}'.`, 1);
      }
      params['at'] = parts;
    } else {
      if (options.yaw !== undefined) {
        params['yaw'] = Number(options.yaw);
      }
      if (options.pitch !== undefined) {
        params['pitch'] = Number(options.pitch);
      }
      if (Object.keys(params).length === 0) {
        throw new CliError('look needs --at x,y,z, or --yaw and/or --pitch.', 1);
      }
    }
    const result = await client.call<Record<string, unknown>>('player.look', params);
    if (global.json) {
      printJson(result);
      return;
    }
    if (!global.quiet) {
      line(`Facing ${Number(result['yaw']).toFixed(1)}/${Number(result['pitch']).toFixed(1)}.`);
    }
  });
}

export async function runInventory(global: GlobalOptions): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<{
      slots: { index: number; item: string | null; count: number; name?: string }[];
      selected: number;
    }>('player.inventory');
    if (global.json) {
      printJson(result);
      return;
    }
    for (const slot of result.slots) {
      if (slot.item === null) {
        continue;
      }
      const marker = slot.index === result.selected ? '>' : ' ';
      line(`${marker} [${String(slot.index).padStart(2)}] ${slot.item} x${slot.count}`);
    }
    if (!global.quiet) {
      line(`# selected hotbar slot ${result.selected}`);
    }
  });
}
