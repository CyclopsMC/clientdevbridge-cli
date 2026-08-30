import { z } from 'zod';

/** The protocol version this CLI speaks. Bumped only by a breaking change landed on every branch. */
export const SUPPORTED_PROTOCOL = 1;

export const helloSchema = z.object({
  protocol: z.number().int(),
  mcVersion: z.string(),
  loader: z.string(),
  clientDevBridgeVersion: z.string(),
  evalEnabled: z.boolean().optional(),
  /** The project this client was launched for; absent on an older bridge build. */
  projectDir: z.string().nullish(),
  mods: z.array(z.string()).default([]),
});

export type Hello = z.infer<typeof helloSchema>;

export const rpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const rpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
});

export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.record(z.unknown()).default({}),
});

/** The metrics block every screenshot and snapshot result carries. */
export const metricsSchema = z.object({
  guiScale: z.number(),
  guiWidth: z.number(),
  guiHeight: z.number(),
  pixelWidth: z.number(),
  pixelHeight: z.number(),
});

export type Metrics = z.infer<typeof metricsSchema>;
