#!/usr/bin/env node
/**
 * Records a `hello` handshake and a protocol transcript from a running client into
 * test/fixtures/transcripts/<name>.json.
 *
 * These fixtures are what lets the CLI's compatibility tests verify a release against every
 * supported branch without booting Minecraft: each branch records one, and `vitest` replays
 * them all. Run this once per branch when the protocol changes.
 *
 * Usage: node scripts/record-fixture.mjs <name> [port]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const name = process.argv[2];
const port = Number(process.argv[3] ?? 25599);
if (name === undefined) {
  console.error('usage: node scripts/record-fixture.mjs <name> [port]');
  process.exit(2);
}

/**
 * Puts the client into the state the transcript is recorded from. This is not part of the
 * transcript: it is what makes the recorded `screen.snapshot` worth having. Recorded from the
 * title screen, a snapshot exercises a handful of buttons and no container at all -- no slots, no
 * item stacks, no menu geometry -- which is most of what a snapshot is for.
 */
const SETUP = [
  ['world.reset', {}],
  ['world.command', { command: 'setblock 0 4 2 minecraft:crafting_table' }],
  ['world.command', { command: 'give @s minecraft:diamond 5' }],
  ['screen.open', { blockPos: [0, 4, 2] }],
];

/** The calls every branch must answer identically, plus two deliberate failures. */
const SCRIPT = [
  ['status', {}],
  ['wait.ticks', { ticks: 2 }],
  ['log.tail', { lines: 2, level: 'warn' }],
  ['screen.snapshot', {}],
  ['nope.does.not.exist', {}],
  ['wait.ticks', { ticks: -1 }],
  ['wait.ticks', { notTicks: 1 }],
];

const socket = new WebSocket(`ws://127.0.0.1:${port}`);
const transcript = { recordedAt: new Date().toISOString(), hello: null, calls: [] };
const pending = new Map();
let nextId = 1;

function call(method, params, { record = true } = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { method, params, resolve, record });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

socket.on('error', (error) => {
  console.error(`Could not connect to ws://127.0.0.1:${port}: ${error.message}`);
  console.error("Start a client first: clientdevbridge start");
  process.exit(2);
});

socket.on('message', async (raw) => {
  const message = JSON.parse(String(raw));
  if (message.method === 'hello') {
    transcript.hello = message;
    for (const [method, params] of SETUP) {
      const response = await call(method, params, { record: false });
      if (response.error !== undefined) {
        console.error(`Setup call ${method} failed: ${response.error.message}`);
        process.exit(1);
      }
    }
    for (const [method, params] of SCRIPT) {
      await call(method, params);
    }
    const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'transcripts');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(transcript, null, 2)}\n`);
    console.log(file);
    socket.close();
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (entry.record) {
      transcript.calls.push({
        request: { jsonrpc: '2.0', id: message.id, method: entry.method, params: entry.params },
        response: message,
      });
    }
    entry.resolve(message);
  }
});
