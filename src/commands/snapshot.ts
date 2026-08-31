import { line, printJson, printPath } from '../output.js';
import { findNodes, formatOutline } from '../snapshot/outline.js';
import { centre, label, simpleType, type Snapshot, type SnapshotNode, snapshotSchema } from '../snapshot/model.js';
import { CliError } from '../errors.js';
import type { BridgeClient } from '../protocol/client.js';
import { type GlobalOptions, timestampName, withClient, writeBase64 } from './context.js';
import { aimParams, type AimOptions } from './input.js';

export async function fetchSnapshot(
  client: BridgeClient,
  options: { includeHidden?: boolean; maxDepth?: number } = {},
): Promise<Snapshot> {
  const params: Record<string, unknown> = {};
  if (options.includeHidden === true) {
    params['includeHidden'] = true;
  }
  if (options.maxDepth !== undefined) {
    params['maxDepth'] = options.maxDepth;
  }
  const raw = await client.call('screen.snapshot', params);
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      `The mod sent a snapshot this CLI cannot read: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      1,
      'This usually means the CLI and the mod are from different releases. Update whichever is older.',
    );
  }
  return parsed.data;
}

/**
 * Drops the empty slots from a container, and says how many there were.
 *
 * A container screen is mostly empty: the modded screen this was measured on had 39 empty slots of
 * 40, and each one costs about eighty bytes of `{"index":n,"item":null,"count":0,"x":..,"y":..}` --
 * 3.2 kB of a 11.7 kB payload to say "nothing here, forty times". The text outline has always
 * omitted them for exactly this reason.
 *
 * `slotCount` keeps what completeness was actually for: the slots are a regular grid, so the
 * geometry of the empty ones is derivable from the filled ones and the total. `--include-empty`
 * restores every rectangle for the caller who wants it, and the protocol is untouched -- the mod
 * still reports all of them, and this is presentation.
 */
function withoutEmptySlots(snapshot: Snapshot, includeEmpty: boolean): unknown {
  const container = snapshot.container;
  if (includeEmpty || container === null) {
    return snapshot;
  }
  const filled = container.slots.filter((slot) => slot.item !== null);
  return {
    ...snapshot,
    container: { ...container, slots: filled, slotCount: container.slots.length },
  };
}

export async function runSnapshot(
  global: GlobalOptions,
  options: { includeHidden: boolean; maxDepth?: string | undefined; includeEmpty: boolean },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const snapshot = await fetchSnapshot(client, {
      includeHidden: options.includeHidden,
      maxDepth: options.maxDepth === undefined ? undefined : Number(options.maxDepth),
    });
    if (global.json) {
      printJson(withoutEmptySlots(snapshot, options.includeEmpty));
      return;
    }
    line(formatOutline(snapshot, { includeHidden: options.includeHidden }));
  });
}

export async function runFind(
  global: GlobalOptions,
  text: string,
  options: { type?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    const snapshot = await fetchSnapshot(client);
    const matches = findNodes(snapshot, text, options.type);

    if (global.json) {
      printJson(matches.map((match) => ({ path: match.node.path, type: match.node.type, centre: match.centre })));
      return;
    }
    if (matches.length === 0) {
      line(`No widget matches '${text}'${options.type === undefined ? '' : ` of type '${options.type}'`}.`);
      line('Run `clientdevbridge snapshot` to see what is on screen.');
      process.exitCode = 1;
      return;
    }
    for (const match of matches) {
      const at = match.centre === null ? 'no bounds' : `click at ${match.centre.x},${match.centre.y}`;
      line(`${simpleType(match.node)} "${label(match.node)}"  ${at}  ${match.node.path}`);
    }
  });
}

/**
 * Turns a `--widget` argument into a point to click.
 *
 * Ambiguity is an error rather than a guess: silently clicking the wrong one of two similarly
 * labelled buttons is far worse than being told to be more specific.
 */
export async function resolveWidget(client: BridgeClient, query: string): Promise<{ x: number; y: number }> {
  const node = await findWidget(client, query);
  const point = centre(node);
  if (point === null) {
    throw new CliError(
      `The widget '${query}' (${node.path}) reports no bounds, so there is nowhere to click.`,
      1,
      'Use --at x,y with coordinates read off a screenshot.',
    );
  }
  return point;
}

/**
 * Resolves a `--widget` argument to the one node it names.
 *
 * Ambiguity is an error rather than a guess: silently acting on the wrong one of two similarly
 * labelled buttons is far worse than being told to be more specific.
 */
export async function findWidget(client: BridgeClient, query: string): Promise<SnapshotNode> {
  const snapshot = await fetchSnapshot(client);
  const matches = findNodes(snapshot, query);

  if (matches.length === 0) {
    throw new CliError(
      `No widget matches '${query}' on ${snapshot.screenClass ?? 'this screen'}.`,
      1,
      'Run `clientdevbridge snapshot` to see the widgets, then pass a label or a /root/children[N] path.',
    );
  }
  if (matches.length > 1) {
    const listed = matches
      .slice(0, 8)
      .map((match) => `  ${simpleType(match.node)} "${label(match.node)}"  ${match.node.path}`)
      .join('\n');
    throw new CliError(
      `'${query}' matches ${matches.length} widgets:\n${listed}`,
      1,
      'Pass the exact path instead, e.g. --widget /root/children[3]',
    );
  }

  return (matches[0] as (typeof matches)[number]).node;
}

/** Re-reads one node by its exact path, for a caller checking what an edit left behind. */
export async function findNodeByPath(client: BridgeClient, path: string): Promise<SnapshotNode | undefined> {
  const snapshot = await fetchSnapshot(client);
  return findNodes(snapshot, path).find((match) => match.node.path === path)?.node;
}

export async function runTooltip(
  global: GlobalOptions,
  options: { at?: string | undefined; widget?: string | undefined },
): Promise<void> {
  await withClient(global, async ({ client }) => {
    let point: { x: number; y: number };
    if (options.widget !== undefined) {
      point = await resolveWidget(client, options.widget);
    } else if (options.at !== undefined) {
      const { parsePoint } = await import('./input.js');
      point = parsePoint(options.at, '--at');
    } else {
      throw new CliError('tooltip needs either --at x,y or --widget <text-or-path>.', 1);
    }

    const result = await client.call<{ lines: string[]; source: string }>('screen.tooltip', point);
    if (global.json) {
      printJson(result);
      return;
    }
    if (result.lines.length === 0) {
      line(`No tooltip at ${point.x},${point.y} (source: ${result.source}).`);
      return;
    }
    for (const entry of result.lines) {
      line(entry);
    }
  });
}

/**
 * The composite an agent reaches for most: open a block's GUI, wait for it, and produce both the
 * outline and a screenshot path in one round trip.
 */
export async function runInspectGui(
  global: GlobalOptions,
  x: string,
  y: string,
  z: string,
  options: { approach: boolean; name?: string | undefined } & AimOptions,
): Promise<void> {
  await withClient(global, async ({ client, paths }) => {
    const opened = await client.call<Record<string, unknown>>(
      'screen.open',
      { blockPos: [Number(x), Number(y), Number(z)], approach: options.approach, ...aimParams(options) },
      60_000,
    );

    if (opened['opened'] !== true) {
      line(`No screen opened for the block at ${x},${y},${z}. ${opened['hint'] ?? ''}`.trim());
      process.exitCode = 1;
      return;
    }

    // One tick so the freshly opened screen has laid itself out before it is described.
    await client.call('wait.ticks', { ticks: 2 });
    const snapshot = await fetchSnapshot(client);
    const shot = await client.call<Record<string, unknown>>('screenshot', {});
    const file = writeBase64(paths.screenshots, options.name ?? timestampName('inspect-gui'), String(shot['png']));

    if (global.json) {
      printJson({ snapshot, screenshot: file });
      return;
    }
    line(formatOutline(snapshot));
    line('');
    printPath(file);
  });
}
