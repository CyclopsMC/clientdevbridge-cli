import { describe, expect, it } from 'vitest';
import { findNodes, formatNode, formatOutline } from '../src/snapshot/outline.js';
import { centre, type Snapshot, type SnapshotNode, snapshotSchema } from '../src/snapshot/model.js';

function node(partial: Partial<SnapshotNode> & { path: string; type: string }): SnapshotNode {
  return {
    bounds: null,
    message: null,
    narration: null,
    visible: true,
    active: true,
    focused: false,
    hovered: false,
    value: null,
    extra: {},
    children: [],
    ...partial,
  };
}

function snapshot(root: SnapshotNode | null, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    screenClass: 'net.minecraft.client.gui.screens.inventory.CraftingScreen',
    title: 'Crafting',
    guiScale: 2,
    guiWidth: 427,
    guiHeight: 240,
    pixelWidth: 854,
    pixelHeight: 480,
    mouse: [0, 0],
    focused: null,
    hovered: null,
    truncated: false,
    container: null,
    root,
    ...overrides,
  };
}

describe('formatNode', () => {
  it('renders the documented one-line shape', () => {
    const rendered = formatNode(
      node({
        path: '/root/children[3]',
        type: 'net.minecraft.client.gui.components.Button',
        message: 'Apply',
        bounds: { x: 312, y: 208, w: 60, h: 20 },
        active: false,
      }),
    );
    expect(rendered).toContain('Button "Apply" @(312,208 60x20)');
    expect(rendered).toContain('disabled');
    expect(rendered).toContain('/root/children[3]');
  });

  it('only mentions states that differ from the default', () => {
    const plain = formatNode(node({ path: '/root/children[0]', type: 'a.b.Button', bounds: { x: 0, y: 0, w: 1, h: 1 } }));
    expect(plain).not.toContain('disabled');
    expect(plain).not.toContain('focused');
    expect(plain).not.toContain('hovered');
    expect(plain).not.toContain('hidden');
  });

  it('falls back to narration when a widget has no message', () => {
    const rendered = formatNode(
      node({ path: '/root/children[0]', type: 'a.b.ImageButton', narration: 'Recipe book' }),
    );
    expect(rendered).toContain('"Recipe book"');
  });

  it('says so when a widget reports no bounds', () => {
    expect(formatNode(node({ path: '/root/children[0]', type: 'a.b.Odd' }))).toContain('@(unknown)');
  });

  it('shows a widget value, formatting floats readably', () => {
    expect(formatNode(node({ path: '/p', type: 'a.Slider', value: 0.5, bounds: { x: 0, y: 0, w: 1, h: 1 } }))).toContain('= 0.500');
    expect(formatNode(node({ path: '/p', type: 'a.EditBox', value: 'hi', bounds: { x: 0, y: 0, w: 1, h: 1 } }))).toContain('= "hi"');
  });
});

describe('formatOutline', () => {
  it('indents by depth and skips the root, which the header already covers', () => {
    const root = node({
      path: '/root',
      type: 'a.b.CraftingScreen',
      children: [
        node({
          path: '/root/children[0]',
          type: 'a.b.Panel',
          bounds: { x: 0, y: 0, w: 10, h: 10 },
          children: [node({ path: '/root/children[0]/children[0]', type: 'a.b.Button', message: 'Ok', bounds: { x: 1, y: 1, w: 2, h: 2 } })],
        }),
      ],
    });
    const lines = formatOutline(snapshot(root)).split('\n');
    expect(lines[0]).toContain('CraftingScreen');
    const panel = lines.find((entry) => entry.includes('Panel')) as string;
    const button = lines.find((entry) => entry.includes('Button')) as string;
    expect(panel.startsWith('  ')).toBe(true);
    expect(button.startsWith('    ')).toBe(true);
  });

  it('hides invisible widgets unless asked for them', () => {
    const root = node({
      path: '/root',
      type: 'a.b.Screen',
      children: [node({ path: '/root/children[0]', type: 'a.b.Button', message: 'Secret', visible: false })],
    });
    expect(formatOutline(snapshot(root))).not.toContain('Secret');
    expect(formatOutline(snapshot(root), { includeHidden: true })).toContain('Secret');
  });

  it('lists container slots that hold something, and the hovered one', () => {
    const rendered = formatOutline(
      snapshot(node({ path: '/root', type: 'a.b.Screen' }), {
        container: {
          menuClass: 'a.b.CraftingMenu',
          leftPos: 125,
          topPos: 37,
          imageWidth: 176,
          imageHeight: 166,
          carried: { item: null, count: 0 },
          slots: [
            { index: 0, item: 'minecraft:stone', count: 3, x: 133, y: 45, hovered: false },
            { index: 1, item: null, count: 0, x: 151, y: 45, hovered: true },
            { index: 2, item: null, count: 0, x: 169, y: 45, hovered: false },
          ],
        },
      }),
    );
    expect(rendered).toContain('3 slots (1 filled)');
    expect(rendered).toContain('minecraft:stone x3 @(133,45)');
    expect(rendered).toContain('hovered');
    // The empty, unhovered slot is noise and is left out.
    expect(rendered).not.toContain('@(169,45)');
  });

  it('says plainly when no screen is open', () => {
    const rendered = formatOutline(snapshot(null, { screenClass: null, title: null }));
    expect(rendered).toContain('No screen is open.');
  });

  it('flags a truncated tree', () => {
    expect(formatOutline(snapshot(node({ path: '/root', type: 'a.S' }), { truncated: true }))).toContain('truncated');
  });
});

describe('findNodes', () => {
  const root = node({
    path: '/root',
    type: 'a.b.Screen',
    children: [
      node({ path: '/root/children[0]', type: 'a.b.Button', message: 'Apply', bounds: { x: 0, y: 0, w: 10, h: 20 } }),
      node({ path: '/root/children[1]', type: 'a.b.Button', message: 'Apply to all', bounds: { x: 0, y: 30, w: 10, h: 20 } }),
      node({ path: '/root/children[2]', type: 'a.b.EditBox', message: 'Name', bounds: { x: 0, y: 60, w: 10, h: 20 } }),
    ],
  });

  it('prefers an exact label match over a substring one', () => {
    const matches = findNodes(snapshot(root), 'Apply');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.path).toBe('/root/children[0]');
  });

  it('matches a path exactly', () => {
    expect(findNodes(snapshot(root), '/root/children[1]')[0]?.node.message).toBe('Apply to all');
  });

  it('falls back to substring matching, reporting the ambiguity', () => {
    expect(findNodes(snapshot(root), 'appl')).toHaveLength(2);
  });

  it('filters by type', () => {
    const matches = findNodes(snapshot(root), 'Name', 'EditBox');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.node.type).toBe('a.b.EditBox');
  });

  it('reports the click centre of a match', () => {
    expect(findNodes(snapshot(root), 'Apply')[0]?.centre).toEqual({ x: 5, y: 10 });
  });
});

describe('centre', () => {
  it('is null when a widget has no bounds', () => {
    expect(centre(node({ path: '/p', type: 'a.B' }))).toBeNull();
  });
});

describe('snapshotSchema', () => {
  it('rejects a payload missing required fields, rather than silently defaulting', () => {
    expect(snapshotSchema.safeParse({ screenClass: 'a.B' }).success).toBe(false);
  });
});
