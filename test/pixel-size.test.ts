import { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { matchRequestedPixelSize } from '../src/launcher.js';
import { SUPPORTED_PROTOCOL } from '../src/protocol/types.js';
import type { Session } from '../src/session.js';

/**
 * A client that answers `window.resize` with whatever framebuffer it decides the request produced.
 *
 * `reached` is the whole point of the fake: a mod build that converts the request into window
 * coordinates reaches the requested size, and one too old to do the conversion answers with the
 * scaled-up framebuffer it already had.
 */
function startFakeClient(reached: { width: number; height: number }): Promise<{
  port: number;
  calls: { method: string; params: unknown }[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const calls: { method: string; params: unknown }[] = [];
    const sockets = new Set<import('ws').WebSocket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'hello',
          params: {
            protocol: SUPPORTED_PROTOCOL,
            mcVersion: '1.21.1',
            loader: 'neoforge',
            clientDevBridgeVersion: '1.0.0-154',
            mods: ['clientdevbridge'],
          },
        }),
      );
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as { id: number; method: string; params: unknown };
        calls.push({ method: request.method, params: request.params });
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { pixelWidth: reached.width, pixelHeight: reached.height, guiScale: 2 },
          }),
        );
      });
    });
    server.on('listening', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        calls,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) {
              socket.terminate();
            }
            server.close(() => done());
          }),
      }),
    );
  });
}

const session = (port: number): Session => ({
  version: 1,
  port,
  pid: process.pid,
  pgid: process.pid,
  loader: 'neoforge',
  mcVersion: '1.21.1',
  bridgeVersion: '1.0.0-154',
  projectDir: process.cwd(),
  gradleTask: ':loader-neoforge:runClient',
  startedAt: new Date().toISOString(),
  world: null,
  headed: false,
  display: 'native window on darwin',
  jdwpPort: null,
});

let client: { port: number; calls: { method: string; params: unknown }[]; close: () => Promise<void> } | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
});

describe('matching the framebuffer to the size that was asked for', () => {
  it('says nothing and sends nothing when the client came up at the requested size', async () => {
    client = await startFakeClient({ width: 854, height: 480 });
    const said: string[] = [];
    await matchRequestedPixelSize(session(client.port), 854, 480, { width: 854, height: 480 }, (l) => said.push(l));
    expect(said).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it('resizes a client whose display scaled the window, and says what it did', async () => {
    client = await startFakeClient({ width: 854, height: 480 });
    const said: string[] = [];
    await matchRequestedPixelSize(session(client.port), 854, 480, { width: 1708, height: 960 }, (l) => said.push(l));
    expect(client.calls).toEqual([{ method: 'window.resize', params: { width: 854, height: 480 } }]);
    expect(said.join('\n')).toContain('1708x960');
    expect(said.join('\n')).toContain('Resized it to 854x480');
  });

  // The case that matters most: a mod build older than the conversion sizes the window in screen
  // coordinates, so the resize is accepted and changes nothing. Reporting that as a success would
  // leave the difference to be discovered by a golden image that cannot say why it did not match.
  it('warns, naming the mod build, when the resize does not take', async () => {
    client = await startFakeClient({ width: 1708, height: 960 });
    const said: string[] = [];
    await matchRequestedPixelSize(session(client.port), 854, 480, { width: 1708, height: 960 }, (l) => said.push(l));
    const message = said.join('\n');
    expect(message).toContain('1708x960');
    expect(message).toContain('did not take');
    expect(message).toContain('1.0.0-154');
  });

  // A display scaling by a fraction has no window size that lands on the request exactly, which is
  // a different problem from a mod that ignored the request, and has a different answer.
  it('says the framebuffer settled nearby when the scale is fractional', async () => {
    client = await startFakeClient({ width: 853, height: 480 });
    const said: string[] = [];
    await matchRequestedPixelSize(session(client.port), 854, 480, { width: 1281, height: 720 }, (l) => said.push(l));
    const message = said.join('\n');
    expect(message).toContain('closest framebuffer');
    expect(message).toContain('853x480');
    expect(message).not.toContain('did not take');
  });

  it('warns rather than failing the launch when the client cannot be reached', async () => {
    const said: string[] = [];
    // Port 1 is privileged and never has a bridge on it, so connecting is a certain failure.
    await matchRequestedPixelSize(session(1), 854, 480, { width: 1708, height: 960 }, (l) => said.push(l));
    expect(said.join('\n')).toContain('did not take');
  });
});
