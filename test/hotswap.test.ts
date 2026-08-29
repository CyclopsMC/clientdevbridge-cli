import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffClasses, readPreviousSnapshot, scanClasses, writeSnapshot } from '../src/hotswap.js';
import { rendererKey } from '../src/commands/compare.js';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-hotswap-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeClass(module: string, binaryName: string, contents: string): void {
  const file = path.join(directory, module, 'build/classes/java/main', `${binaryName.split('.').join('/')}.class`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe('scanClasses', () => {
  it('finds classes in every loader module and keys them by binary name', () => {
    writeClass('loader-neoforge', 'org.example.Alpha', 'one');
    writeClass('loader-fabric', 'org.example.Beta', 'two');
    const classes = scanClasses(directory);
    expect([...classes.keys()].sort()).toEqual(['org.example.Alpha', 'org.example.Beta']);
  });

  it('keeps one entry when the shared sources are compiled into both loaders', () => {
    writeClass('loader-neoforge', 'org.example.Shared', 'same');
    writeClass('loader-fabric', 'org.example.Shared', 'same');
    expect(scanClasses(directory).size).toBe(1);
  });
});

describe('diffClasses', () => {
  it('reports nothing changed with no baseline, rather than swapping the whole project', () => {
    writeClass('loader-neoforge', 'org.example.Alpha', 'one');
    const result = diffClasses(null, scanClasses(directory));
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('reports a changed class once its contents differ', () => {
    writeClass('loader-neoforge', 'org.example.Alpha', 'before');
    writeSnapshot(path.join(directory, 'state'), scanClasses(directory));

    writeClass('loader-neoforge', 'org.example.Alpha', 'after');
    const result = diffClasses(readPreviousSnapshot(path.join(directory, 'state')), scanClasses(directory));
    expect(result.changed.map((entry) => entry.binaryName)).toEqual(['org.example.Alpha']);
  });

  it('separates newly compiled classes from changed ones', () => {
    writeClass('loader-neoforge', 'org.example.Alpha', 'one');
    writeSnapshot(path.join(directory, 'state'), scanClasses(directory));

    writeClass('loader-neoforge', 'org.example.Beta', 'two');
    const result = diffClasses(readPreviousSnapshot(path.join(directory, 'state')), scanClasses(directory));
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual(['org.example.Beta']);
  });

  it('reports nothing when the bytes are identical, even after a rebuild', () => {
    writeClass('loader-neoforge', 'org.example.Alpha', 'same');
    writeSnapshot(path.join(directory, 'state'), scanClasses(directory));
    writeClass('loader-neoforge', 'org.example.Alpha', 'same');
    expect(diffClasses(readPreviousSnapshot(path.join(directory, 'state')), scanClasses(directory)).changed).toEqual([]);
  });
});

describe('rendererKey', () => {
  it('groups every software rasteriser under one golden set', () => {
    expect(rendererKey('llvmpipe (LLVM 20.1.2, 256 bits)')).toBe('llvmpipe');
    expect(rendererKey('softpipe')).toBe('llvmpipe');
  });

  it('groups real hardware under another', () => {
    expect(rendererKey('NVIDIA GeForce RTX 4090/PCIe/SSE2')).toBe('gpu');
    expect(rendererKey('Apple M2')).toBe('gpu');
  });

  it('falls back rather than throwing when the renderer is unknown', () => {
    expect(rendererKey(null)).toBe('unknown');
    expect(rendererKey('')).toBe('unknown');
  });
});
