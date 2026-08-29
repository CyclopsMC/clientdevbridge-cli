import { z } from 'zod';

export const boundsSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Bounds = z.infer<typeof boundsSchema>;

export interface SnapshotNode {
  path: string;
  type: string;
  bounds: Bounds | null;
  message: string | null;
  narration: string | null;
  visible: boolean;
  active: boolean;
  focused: boolean;
  hovered: boolean;
  value?: unknown;
  extra: Record<string, unknown>;
  children: SnapshotNode[];
}

// The input type differs from the output type because of the `.default()`s, so the third
// type argument is `unknown` rather than SnapshotNode.
export const snapshotNodeSchema: z.ZodType<SnapshotNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    path: z.string(),
    type: z.string(),
    bounds: boundsSchema.nullable(),
    message: z.string().nullable(),
    narration: z.string().nullable(),
    visible: z.boolean(),
    active: z.boolean(),
    focused: z.boolean(),
    hovered: z.boolean(),
    value: z.unknown(),
    extra: z.record(z.unknown()).default({}),
    children: z.array(snapshotNodeSchema).default([]),
  }),
);

export const slotSchema = z.object({
  index: z.number(),
  item: z.string().nullable(),
  count: z.number(),
  name: z.string().optional(),
  x: z.number(),
  y: z.number(),
  hovered: z.boolean(),
});

export const containerSchema = z.object({
  menuClass: z.string(),
  leftPos: z.number(),
  topPos: z.number(),
  imageWidth: z.number(),
  imageHeight: z.number(),
  carried: z.object({ item: z.string().nullable(), count: z.number() }).passthrough(),
  slots: z.array(slotSchema),
});

export const snapshotSchema = z.object({
  screenClass: z.string().nullable(),
  title: z.string().nullable(),
  guiScale: z.number(),
  guiWidth: z.number(),
  guiHeight: z.number(),
  pixelWidth: z.number(),
  pixelHeight: z.number(),
  mouse: z.array(z.number()),
  focused: z.string().nullable().optional(),
  hovered: z.string().nullable().optional(),
  truncated: z.boolean().default(false),
  container: containerSchema.nullable(),
  root: snapshotNodeSchema.nullable(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Slot = z.infer<typeof slotSchema>;

/** Depth-first walk, parents before children. */
export function walk(node: SnapshotNode, visit: (node: SnapshotNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children) {
    walk(child, visit, depth + 1);
  }
}

export function flatten(root: SnapshotNode | null): { node: SnapshotNode; depth: number }[] {
  if (root === null) {
    return [];
  }
  const all: { node: SnapshotNode; depth: number }[] = [];
  walk(root, (node, depth) => all.push({ node, depth }));
  return all;
}

/** The point a click should target for a node. */
export function centre(node: SnapshotNode): { x: number; y: number } | null {
  if (node.bounds === null) {
    return null;
  }
  return {
    x: node.bounds.x + Math.floor(node.bounds.w / 2),
    y: node.bounds.y + Math.floor(node.bounds.h / 2),
  };
}

/** A short, human-meaningful label for a node: its message, else its narration, else nothing. */
export function label(node: SnapshotNode): string {
  if (node.message !== null && node.message.length > 0) {
    return node.message;
  }
  if (node.narration !== null && node.narration.length > 0) {
    return node.narration;
  }
  return '';
}

export function simpleType(node: SnapshotNode): string {
  const parts = node.type.split('.');
  return parts[parts.length - 1] ?? node.type;
}
