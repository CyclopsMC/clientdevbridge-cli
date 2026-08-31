import { line, printJson, warn } from '../output.js';
import { type GlobalOptions, withClient } from './context.js';
import { CliError, EXIT_PROTOCOL } from '../errors.js';
import { aimParams, type AimOptions } from './input.js';

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
  options: { nbt?: boolean | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const position = parsePosition(x, y, z);
    // Asking for one block is already a targeted question, and the answer a mod block is asked for
    // is almost always in its NBT, so --json carries it unless --no-nbt says otherwise. The plain
    // text form stays terse, because there it is a wall of NBT under a one-line answer.
    const nbt = options.nbt ?? global.json;
    const result = await client.call<Record<string, unknown>>('world.block', { ...position, nbt });
    if (global.json) {
      printJson(result);
      return;
    }
    line(String(result['state']));
    const blockEntity = result['blockEntity'] as Record<string, unknown> | null;
    if (blockEntity !== null) {
      line(`block entity: ${blockEntity['type']}`);
      // Whatever the owning mod said distinguishes this instance -- which side of a cable carries
      // which part, say. Without it a cable with a part and a bare one read identically.
      const details = blockEntity['details'] as Record<string, unknown> | undefined;
      if (details !== undefined) {
        for (const [key, value] of Object.entries(details)) {
          line(`  ${key}: ${String(value)}`);
        }
      }
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

/**
 * Breaks a block by mining it, which no single click can do.
 *
 * Mining is a held action whose length depends on the block, the tool and whether the tool is even
 * the right one — so the mod holds attack and ticks the progress until the block gives way, and the
 * tick count comes back as the observable difference between the right tool and the wrong one.
 */
export async function runBreak(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { approach: boolean; timeoutTicks?: string | undefined } & AimOptions,
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = {
      blockPos: [Number(x), Number(y), Number(z)],
      approach: options.approach,
      ...aimParams(options),
    };
    if (options.timeoutTicks !== undefined) {
      params['timeoutTicks'] = Number(options.timeoutTicks);
    }
    const result = await client.call<Record<string, unknown>>('world.break', params, 120_000);
    if (global.json) {
      printJson(result);
      return;
    }
    const drops = (result['drops'] as { item: string; count: number; pos: number[] }[] | undefined) ?? [];
    if (result['broken'] === true) {
      if (!global.quiet) {
        line(`broke ${result['blockBefore']} in ${result['ticks']} ticks`);
        for (const drop of drops) {
          // With the position, because a drop is thrown rather than placed and lands a block or
          // two from where the block was -- which is where you have to walk to pick it up.
          const at = drop.pos.map((value) => value.toFixed(2)).join(', ');
          line(`  dropped ${drop.item} x${drop.count} at ${at}`);
        }
        if (drops.length === 0) {
          line('  nothing dropped');
        }
      }
      return;
    }
    line(
      `${result['blockBefore']} at ${x},${y},${z} did not break after ${result['ticks']} ticks. ` +
        'Either the block is unbreakable, the held item cannot harvest it, or the player is out of reach.',
    );
    process.exitCode = 1;
  });
}

/**
 * Selects a hotbar slot, which is what "hold this" means to the game.
 *
 * Everything that places, uses or mines acts on the selected slot, so without this the only way to
 * hold an item was to give it while slot 0 happened to be empty. `give` fills the first free slot,
 * so the second item given was already unreachable. The client sends the selection to the server
 * lazily, right before the next interaction, so setting it directly is enough.
 */
export async function runHold(global: GlobalOptions, slot: string): Promise<void> {
  const index = Number.parseInt(slot, 10);
  if (!Number.isInteger(index) || index < 0 || index > 8) {
    throw new CliError(`Hotbar slot must be 0-8, but was '${slot}'.`, 1);
  }
  await withClient(global, async ({ client }) => {
    const result = await client.call<{ selected: number; item: string | null; count: number }>(
      'player.hotbar',
      { slot: index },
    );
    if (global.json) {
      printJson(result);
      return;
    }
    line(
      result.item === null
        ? `holding slot ${result.selected}, which is empty`
        : `holding slot ${result.selected}: ${result.item} x${result.count}`,
    );
  });
}

/**
 * Walks to a position instead of teleporting to it, for when the movement is the point.
 *
 * The manual version is resetting the pitch — walking forward while looking down walks into the
 * ground — and then guessing a tick count, which is dead reckoning: nothing says how far twenty
 * ticks goes.
 */
export async function runWalkTo(
  global: GlobalOptions,
  x: string,
  z: string,
  options: { within?: string | undefined; timeoutTicks?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const params: Record<string, unknown> = { x: Number(x), z: Number(z) };
    if (options.within !== undefined) {
      params['within'] = Number(options.within);
    }
    if (options.timeoutTicks !== undefined) {
      params['timeoutTicks'] = Number(options.timeoutTicks);
    }
    const result = await client.call<Record<string, unknown>>('player.walkTo', params, 120_000);
    if (global.json) {
      printJson(result);
      return;
    }
    const pos = result['pos'] as number[];
    const at = pos.map((value) => value.toFixed(2)).join(', ');
    if (result['arrived'] === true) {
      if (!global.quiet) {
        line(`Walked to ${at}.`);
      }
      return;
    }
    line(`Stopped at ${at} without reaching ${x}, ${z}. Something is in the way, or it is too far.`);
    process.exitCode = 1;
  });
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
      const requested = result['requested'] as number[] | undefined;
      const at = pos.map((value) => value.toFixed(2)).join(', ');
      line(`Player at ${at}, facing ${result['yaw']}/${result['pitch']}.`);
      // Gravity acts between the teleport and the reply, so the reported y is routinely lower than
      // the one asked for: a target that is not already resting on a surface is settled onto one,
      // and that is the command working. Reporting every such landing as "fell or was pushed" cried
      // wolf on the normal case and buried the one that matters, so the two are separated here. A
      // horizontal difference is the surprising one -- it means the target was inside something.
      if (requested !== undefined) {
        const drift = requested.map((value, index) => value - (pos[index] ?? 0));
        const blocked = Math.abs(drift[0] ?? 0) > 0.5 || Math.abs(drift[2] ?? 0) > 0.5;
        if (blocked) {
          line(
            `(asked for ${requested.map((value) => value.toFixed(2)).join(', ')}; the player did not get there -- ` +
              'something is in the way, or the target is inside a block)',
          );
        } else if (Math.abs(drift[1] ?? 0) > 0.1) {
          line(`(asked for y ${(requested[1] ?? 0).toFixed(2)}; settled onto the ground at ${(pos[1] ?? 0).toFixed(2)})`);
        }
      }
      // The position above is a snapshot of something still moving, so anything measured from it --
      // a screenshot most of all -- is of somewhere else by the time it is taken.
      if (result['falling'] === true) {
        warn(
          'The player is still falling: nothing solid is under ' +
            `${requested === undefined ? 'the target' : requested.map((value) => value.toFixed(0)).join(', ')}, ` +
            'so this position is already out of date.',
        );
        line('Teleport onto a block, or place one first, before taking a screenshot.');
      }
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

/**
 * Lists what the loaded mods have registered.
 *
 * The lists are long — one mod in the survey had 53 blocks and 90 items — so this prints names and
 * nothing else, and `--limit` caps it rather than letting a stray call dump the whole registry into
 * a caller's context. `--filter` is the usual way to narrow it further.
 */
export async function runRegistry(
  global: GlobalOptions,
  kind: string,
  namespace: string | undefined,
  options: { filter?: string | undefined; limit: string },
): Promise<void> {
  const wanted = kind.toLowerCase();
  if (!['blocks', 'items', 'namespaces'].includes(wanted)) {
    throw new CliError(`'${kind}' is not a registry.`, 2, 'Use blocks, items or namespaces.');
  }
  const call = wanted === 'namespaces'
    ? 'dev.namespaces()'
    : `dev.${wanted}(${namespace === undefined ? '' : JSON.stringify(namespace)})`;

  await withClient(global, async ({ client }) => {
    const result = await client.call<{ value: unknown }>('eval', { language: 'groovy', code: call });
    const all = (Array.isArray(result.value) ? result.value : []).map((entry) =>
      typeof entry === 'string' ? entry : String((entry as { toString?: string })?.toString ?? entry),
    );
    const matched = options.filter === undefined
      ? all
      : all.filter((name) => name.includes(options.filter as string));
    const limit = Number(options.limit);
    const shown = matched.slice(0, limit);

    if (global.json) {
      printJson({ kind: wanted, namespace: namespace ?? null, total: matched.length, names: shown });
      return;
    }
    for (const name of shown) {
      line(name);
    }
    if (matched.length > shown.length && !global.quiet) {
      line(`# ${matched.length} matched; showing ${shown.length}. Narrow with --filter or raise --limit.`);
    }
  });
}

export async function runInventory(
  global: GlobalOptions,
  options: { includeEmpty: boolean } = { includeEmpty: false },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const result = await client.call<{
      slots: { index: number; item: string | null; count: number; name?: string }[];
      selected: number;
    }>('player.inventory');
    if (global.json) {
      // A player inventory is forty-one slots and almost always nearly empty: one item cost 2,909
      // bytes to report, of which all but a couple of hundred said "nothing here". The indices are
      // on the slots that remain, so nothing is ambiguous.
      printJson(options.includeEmpty
        ? result
        : { ...result, slots: result.slots.filter((slot) => slot.item !== null), slotCount: result.slots.length });
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

/**
 * Right-clicks a block with whatever is held.
 *
 * `open-gui` is this plus a wait for a screen, and it fails when none appears. Most interactions
 * never open one -- placing a block or a cable part, using a tool, wrenching -- so they need a
 * command that reports what changed rather than one that treats a quiet click as an error.
 */
export async function runUse(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { approach: boolean; sneak: boolean; hand: string } & AimOptions,
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const position = parsePosition(x, y, z);
    const result = await client.call<Record<string, unknown>>(
      'world.use',
      {
        blockPos: [position['x'], position['y'], position['z']],
        approach: options.approach,
        sneak: options.sneak,
        hand: options.hand,
        ...aimParams(options),
      },
      60_000,
    );
    if (global.json) {
      printJson(result);
      return;
    }
    const pos = (result['pos'] as number[]).join(',');
    line(`used the ${options.hand} hand on the ${result['face']} side of ${pos}: ${result['result']}`);
    // A use is only visible as a difference, and which difference depends on what was clicked. None
    // of them is reliable alone -- creative consumes nothing, and a cable gaining a part changes
    // neither its id nor its state -- so the interaction's own result above is the one to trust,
    // and these say what came of it.
    const changes: string[] = [];
    if (result['blockBefore'] !== result['blockAfter']) {
      changes.push(`block ${result['blockBefore']} -> ${result['blockAfter']}`);
    }
    if (result['heldBefore'] !== result['heldAfter']) {
      changes.push(`held ${result['heldBefore']} -> ${result['heldAfter']}`);
    }
    // The one that catches a machine being configured: a wrench, a card being written, a tank
    // filling. None of those touch the block id or the state, and all of them are in the NBT, so
    // without this the whole class of interactions that actually matter read as "no visible
    // change". The NBT itself is not printed -- it is long, and `block --nbt` asks for it.
    if (result['blockEntityBefore'] !== result['blockEntityAfter']) {
      changes.push(result['blockEntityBefore'] === '' || result['blockEntityAfter'] === ''
        ? `block entity ${result['blockEntityAfter'] === '' ? 'gone' : 'appeared'}`
        : 'block entity NBT changed (read it with `block --nbt`)');
    }
    if (result['screenOpened'] === true) {
      changes.push(`screen ${result['screenClass']}`);
    }
    line(changes.length === 0
      ? 'no visible change to the block, the hand or the screen'
      : changes.join('\n'));
  });
}
