import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/version.js';

describe('packageVersion', () => {
  it('is the version in package.json, not a copy of it', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    expect(packageVersion()).toBe(declared);
  });

  it('resolves the manifest relative to its own file, so it survives being in dist/', () => {
    // The published layout is <pkg>/dist/version.js next to <pkg>/package.json; the checkout is
    // <repo>/src/version.ts next to <repo>/package.json. Both are one level up, which is the
    // assumption worth pinning: an output directory change would silently break --version.
    expect(packageVersion()).not.toBe('unknown');
  });
});
