import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/protocol/client.js';
import { SUPPORTED_PROTOCOL } from '../src/protocol/types.js';
import { snapshotSchema } from '../src/snapshot/model.js';
import { formatOutline } from '../src/snapshot/outline.js';
import { ProtocolError, SessionError } from '../src/errors.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');

function callKey(method: string, params: unknown): string {
  return `${method}\u0000${JSON.stringify(params ?? {})}`;
}

interface Transcript {
  hello: { method: string; params: Record<string, unknown> };
  calls: { request: { id: number; method: string; params: unknown }; response: Record<string, unknown> }[];
}

/**
 * Replays a recorded transcript over a real WebSocket, so a CLI release can be checked against
 * every supported branch without booting Minecraft.
 */
function startReplayServer(transcript: Transcript): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const sockets = new Set<import('ws').WebSocket>();
    // Keyed by method *and* params: a transcript deliberately calls the same method more than
    // once (a valid call and a rejected one), and keying by name alone would lose the difference.
    const byCall = new Map<string, Record<string, unknown>>();
    for (const call of transcript.calls) {
      byCall.set(callKey(call.request.method, call.request.params), call.response);
    }

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.send(JSON.stringify(transcript.hello));
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: unknown };
        const recorded = byCall.get(callKey(request.method, request.params));
        if (recorded === undefined) {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: `Unknown method '${request.method}'` },
            }),
          );
          return;
        }
        socket.send(JSON.stringify({ ...recorded, id: request.id }));
      });
    });

    server.on('listening', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            // close() alone waits for open connections, and a rejected handshake leaves one behind.
            for (const socket of sockets) {
              socket.terminate();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

const fixtures = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((entry) => entry.endsWith('.json'))
  : [];

describe('recorded transcripts', () => {
  let running: { close: () => Promise<void> } | null = null;

  afterEach(async () => {
    await running?.close();
    running = null;
  });

  it('has at least one fixture, so this suite is not silently vacuous', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    const transcript = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fixture), 'utf8')) as Transcript;

    describe(fixture, () => {
      it('speaks the protocol version this CLI supports', () => {
        expect(transcript.hello.params['protocol']).toBe(SUPPORTED_PROTOCOL);
      });

      it('completes the handshake and reports the branch it came from', async () => {
        const server = await startReplayServer(transcript);
        running = server;
        const client = await BridgeClient.connect({ port: server.port });
        expect(client.hello.mcVersion).toBe(transcript.hello.params['mcVersion']);
        expect(client.hello.loader).toBe(transcript.hello.params['loader']);
        expect(client.hello.mods).toContain('clientdevbridge');
        client.close();
      });

      it('parses every recorded success result', async () => {
        const server = await startReplayServer(transcript);
        running = server;
        const client = await BridgeClient.connect({ port: server.port });

        for (const call of transcript.calls) {
          if (call.response['error'] !== undefined) {
            continue;
          }
          const result = await client.call(call.request.method, call.request.params as Record<string, unknown>);
          expect(result).toEqual(call.response['result']);
        }
        client.close();
      });

      it('surfaces every recorded error as a ProtocolError with its code', async () => {
        const server = await startReplayServer(transcript);
        running = server;
        const client = await BridgeClient.connect({ port: server.port });

        const errors = transcript.calls.filter((call) => call.response['error'] !== undefined);
        expect(errors.length).toBeGreaterThan(0);
        for (const call of errors) {
          const recorded = call.response['error'] as { code: number; message: string };
          await expect(
            client.call(call.request.method, call.request.params as Record<string, unknown>),
          ).rejects.toMatchObject({ code: recorded.code });
        }
        client.close();
      });

      it('renders the recorded snapshot as an outline', async () => {
        const snapshotCall = transcript.calls.find((call) => call.request.method === 'screen.snapshot');
        if (snapshotCall === undefined || snapshotCall.response['error'] !== undefined) {
          return;
        }
        const parsed = snapshotSchema.parse(snapshotCall.response['result']);
        const outline = formatOutline(parsed);
        expect(outline.length).toBeGreaterThan(0);
        expect(outline).toContain(`@ scale ${parsed.guiScale}`);
      });
    });
  }
});

describe('handshake failures', () => {
  let running: { close: () => Promise<void> } | null = null;

  afterEach(async () => {
    await running?.close();
    running = null;
  });

  it('tells the user which side to update on a protocol mismatch', async () => {
    const server = await startReplayServer({
      hello: {
        jsonrpc: '2.0',
        method: 'hello',
        params: { protocol: 99, mcVersion: '1.21.1', loader: 'neoforge', clientDevBridgeVersion: '1.0.0', mods: [] },
      } as unknown as Transcript['hello'],
      calls: [],
    });
    running = server;
    await expect(BridgeClient.connect({ port: server.port })).rejects.toThrow(/update the CLI/);
  });

  it('reports a refused connection as a session error, not a crash', async () => {
    // Port 1 on loopback is not something a dev client ever binds.
    await expect(BridgeClient.connect({ port: 1, timeoutMs: 2000 })).rejects.toBeInstanceOf(SessionError);
  });
});

describe('error classes', () => {
  it('uses exit code 1 for protocol errors and 2 for session errors', () => {
    expect(new ProtocolError(-32602, 'bad').exitCode).toBe(1);
    expect(new SessionError('gone').exitCode).toBe(2);
  });
});
