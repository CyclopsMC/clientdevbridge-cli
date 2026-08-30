import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { urlHost } from '../src/loopback.js';
import { isPortFree } from '../src/launcher.js';

describe('urlHost', () => {
  it('brackets an IPv6 literal and leaves IPv4 alone', () => {
    expect(urlHost('::1')).toBe('[::1]');
    expect(urlHost('127.0.0.1')).toBe('127.0.0.1');
  });
});

describe('isPortFree', () => {
  it('is true for a port nobody is on', async () => {
    // Bind to learn a free port, then release it. A hardcoded number would be flaky.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address() as net.AddressInfo;
        probe.close(() => resolve(address.port));
      });
    });
    expect(await isPortFree(port)).toBe(true);
  });

  it('is false for a server on the IPv4 loopback only', async () => {
    // The IPv6 probe cannot connect here, so this also covers the case that broke NeoForge in
    // reverse: one family answering has to be enough to call the port taken.
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
