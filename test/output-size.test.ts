import { describe, expect, it, afterEach } from 'vitest';
import { printJson } from '../src/output.js';

function capture(action: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    action();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

const wasTTY = process.stdout.isTTY;
afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { value: wasTTY, configurable: true });
});

function setTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

describe('printJson', () => {
  const value = { a: 1, b: { c: [1, 2, 3] } };

  it('is compact when stdout is not a terminal, which is where it costs tokens', () => {
    setTTY(undefined);
    const out = capture(() => printJson(value));
    expect(out).toBe('{"a":1,"b":{"c":[1,2,3]}}\n');
  });

  it('indents at a terminal, where a person is reading it', () => {
    setTTY(true);
    const out = capture(() => printJson(value));
    expect(out).toContain('\n  "a": 1');
  });

  it('carries the same information either way', () => {
    setTTY(undefined);
    const compact = capture(() => printJson(value));
    setTTY(true);
    const pretty = capture(() => printJson(value));
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
  });
});
