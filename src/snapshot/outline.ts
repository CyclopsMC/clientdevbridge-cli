import { centre, flatten, label, type Slot, type Snapshot, type SnapshotNode, simpleType } from './model.js';

/**
 * Renders a snapshot as one line per widget, indented by depth.
 *
 * This is the format an agent actually reads, so it is optimised for scanning: the type and label
 * first, then the geometry it would need to click, then only the flags that are *not* the default.
 * A line looks like:
 *
 * ```
 *   Button "Apply" @(312,208 60x20) disabled  /root/children[3]
 * ```
 *
 * The trailing path is what `click --widget` consumes, so an outline line can be copied verbatim.
 */
export function formatOutline(snapshot: Snapshot, options: { includeHidden?: boolean } = {}): string {
  const lines: string[] = [];

  if (snapshot.screenClass === null) {
    lines.push('No screen is open.');
    lines.push(`window ${snapshot.pixelWidth}x${snapshot.pixelHeight}px, gui ${snapshot.guiWidth}x${snapshot.guiHeight} @ scale ${snapshot.guiScale}`);
    return lines.join('\n');
  }

  lines.push(`${simpleType({ type: snapshot.screenClass } as SnapshotNode)}  "${snapshot.title ?? ''}"`);
  lines.push(
    `gui ${snapshot.guiWidth}x${snapshot.guiHeight} @ scale ${snapshot.guiScale}` +
      `, window ${snapshot.pixelWidth}x${snapshot.pixelHeight}px` +
      `, mouse at ${snapshot.mouse.join(',')}`,
  );

  if (snapshot.container !== null) {
    const container = snapshot.container;
    const filled = container.slots.filter((slot) => slot.item !== null).length;
    lines.push(
      `container ${simpleType({ type: container.menuClass } as SnapshotNode)}` +
        ` at (${container.leftPos},${container.topPos}) ${container.imageWidth}x${container.imageHeight}` +
        `, ${container.slots.length} slots (${filled} filled)`,
    );
    for (const slot of container.slots) {
      if (slot.item === null && !slot.hovered) {
        continue;
      }
      lines.push(`  ${formatSlot(slot)}`);
    }
    if (container.carried.item !== null) {
      lines.push(`  carried: ${container.carried.item} x${container.carried.count}`);
    }
  }

  const nodes = flatten(snapshot.root);
  // The root node is the screen itself, already summarised above.
  for (const { node, depth } of nodes.slice(1)) {
    if (!node.visible && options.includeHidden !== true) {
      continue;
    }
    lines.push(`${'  '.repeat(depth)}${formatNode(node)}`);
  }

  if (nodes.length <= 1 && snapshot.container === null) {
    lines.push('(this screen has no widgets)');
  }
  if (snapshot.truncated) {
    lines.push('# truncated: the widget tree hit the depth or node limit');
  }
  return lines.join('\n');
}

export function formatSlot(slot: Slot): string {
  const item = slot.item === null ? '(empty)' : `${slot.item} x${slot.count}`;
  const flags = slot.hovered ? ' hovered' : '';
  return `slot ${String(slot.index).padStart(2)} ${item} @(${slot.x},${slot.y})${flags}`;
}

export function formatNode(node: SnapshotNode): string {
  const parts: string[] = [simpleType(node)];

  const text = label(node);
  if (text.length > 0) {
    parts.push(`"${text}"`);
  }

  if (node.bounds !== null) {
    parts.push(`@(${node.bounds.x},${node.bounds.y} ${node.bounds.w}x${node.bounds.h})`);
  } else {
    parts.push('@(unknown)');
  }

  if (node.value !== null && node.value !== undefined) {
    parts.push(`= ${formatValue(node.value)}`);
  }

  // Only the states that differ from the default are worth a reader's attention.
  if (!node.active) {
    parts.push('disabled');
  }
  if (!node.visible) {
    parts.push('hidden');
  }
  if (node.focused) {
    parts.push('focused');
  }
  if (node.hovered) {
    parts.push('hovered');
  }

  const tooltip = node.extra['tooltip'];
  if (Array.isArray(tooltip) && tooltip.length > 0) {
    parts.push(`tooltip="${tooltip.join(' / ')}"`);
  }

  parts.push(` ${node.path}`);
  return parts.join(' ');
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return JSON.stringify(value);
}

export interface Match {
  readonly node: SnapshotNode;
  readonly centre: { x: number; y: number } | null;
}

/**
 * Finds nodes by label, by path, or by type.
 *
 * An exact path match wins outright, then an exact label match, then a case-insensitive
 * substring match — so `click --widget Apply` picks the "Apply" button even on a screen that
 * also has an "Apply to all" one.
 */
export function findNodes(snapshot: Snapshot, query: string, typeFilter?: string): Match[] {
  const all = flatten(snapshot.root).map(({ node }) => node);
  const candidates =
    typeFilter === undefined
      ? all
      : all.filter((node) => simpleType(node).toLowerCase().includes(typeFilter.toLowerCase()));

  const byPath = candidates.filter((node) => node.path === query);
  if (byPath.length > 0) {
    return byPath.map(toMatch);
  }

  const lowered = query.toLowerCase();
  const exact = candidates.filter((node) => label(node).toLowerCase() === lowered);
  if (exact.length > 0) {
    return exact.map(toMatch);
  }

  return candidates
    .filter(
      (node) =>
        label(node).toLowerCase().includes(lowered) || simpleType(node).toLowerCase() === lowered,
    )
    .map(toMatch);
}

function toMatch(node: SnapshotNode): Match {
  return { node, centre: centre(node) };
}
