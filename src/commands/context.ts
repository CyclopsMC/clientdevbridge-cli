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
 * A connection held open across several commands, or undefined when each command opens its own.
 *
 * Every command reaches the client through {@link withClient}, so this one variable is the whole
 * of batch mode: while it is set, connecting is free and nobody closes the socket. That is worth
 * a mutable module-level value, because the alternative -- threading an optional connection
 * through every command signature -- would put batch mode in forty places instead of one.
 */
let sticky: Connected | undefined;

/**
 * Opens one connection and keeps it open until the returned function is called.
 *
 * The connection is per-project, so a caller that switches projects mid-batch would be wrong; the
 * batch command does not offer that, and this asserts it rather than silently reusing the socket.
 */
export async function holdConnection(options: GlobalOptions): Promise<() => void> {
  if (sticky !== undefined) {
    throw new Error('A connection is already being held; batches do not nest.');
  }
  sticky = await connect(options);
  return () => {
    const held = sticky;
    sticky = undefined;
    held?.client.close();
  };
}

/**
 * Connects to the running client for the project, or fails with a message that says what to run.
 */
export async function connect(options: GlobalOptions): Promise<Connected> {
  if (sticky !== undefined) {
    return sticky;
  }
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
    if (connected !== sticky) {
      connected.client.close();
    }
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
