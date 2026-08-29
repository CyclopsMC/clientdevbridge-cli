import * as fs from 'node:fs';
import * as path from 'node:path';
import { BridgeClient } from '../protocol/client.js';
import { requireRunningSession } from '../session.js';
import type { BridgePaths } from '../paths.js';
import type { Session } from '../session.js';

export interface GlobalOptions {
  readonly project: string;
  readonly json: boolean;
  readonly quiet: boolean;
}

export interface Connected {
  readonly client: BridgeClient;
  readonly session: Session;
  readonly paths: BridgePaths;
}

/**
 * Connects to the running client for the project, or fails with a message that says what to run.
 */
export async function connect(options: GlobalOptions): Promise<Connected> {
  const { session, paths } = requireRunningSession(options.project);
  const client = await BridgeClient.connect({ port: session.port });
  return { client, session, paths };
}

/** Runs an action against a connected client and always closes the socket afterwards. */
export async function withClient<T>(options: GlobalOptions, action: (connected: Connected) => Promise<T>): Promise<T> {
  const connected = await connect(options);
  try {
    return await action(connected);
  } finally {
    connected.client.close();
  }
}

export function timestampName(prefix: string): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `${prefix}_${now}`;
}

/**
 * Writes a base64 payload to a file and returns its absolute path.
 */
export function writeBase64(directory: string, name: string, base64: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name.endsWith('.png') ? name : `${name}.png`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return path.resolve(file);
}
