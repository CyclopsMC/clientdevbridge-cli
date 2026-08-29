import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignore, resolvePaths } from '../src/paths.js';
import { isProcessAlive, readSession, requireRunningSession, writeSession, type Session } from '../src/session.js';
import { SessionError } from '../src/errors.js';

let directory: string;

const session = (overrides: Partial<Session> = {}): Session => ({
  version: 1,
  port: 25599,
  pid: process.pid,
  pgid: process.pid,
  loader: 'neoforge',
  mcVersion: '1.21.1',
  bridgeVersion: '1.0.0-DEV',
  projectDir: directory,
  gradleTask: ':loader-neoforge:runClient',
  startedAt: new Date().toISOString(),
  world: null,
  headed: false,
  display: 'xvfb',
  jdwpPort: null,
  ...overrides,
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-session-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('session state', () => {
  it('reports nothing running in a fresh checkout, without calling it stale', () => {
    const status = readSession(directory);
    expect(status.session).toBeNull();
    expect(status.stale).toBe(false);
  });

  it('round-trips a session', () => {
    const paths = resolvePaths(directory);
    fs.mkdirSync(paths.root, { recursive: true });
    writeSession(paths, session());
    expect(readSession(directory).session?.port).toBe(25599);
  });

  it('detects a session whose process is gone, which is what a reclaimed VM leaves behind', () => {
    const paths = resolvePaths(directory);
    fs.mkdirSync(paths.root, { recursive: true });
    // PID 2^22 is above Linux's default pid_max, so it cannot be a live process.
    writeSession(paths, session({ pid: 4194304, pgid: 4194304 }));
    expect(readSession(directory).stale).toBe(true);
  });

  it('treats an unreadable session file as stale rather than throwing', () => {
    const paths = resolvePaths(directory);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.sessionFile, '{ this is not json');
    const status = readSession(directory);
    expect(status.session).toBeNull();
    expect(status.stale).toBe(true);
  });

  it('tells the caller what to run when nothing is running', () => {
    try {
      requireRunningSession(directory);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).hint).toContain('clientdevbridge start');
      expect((error as SessionError).exitCode).toBe(2);
    }
  });

  it('knows its own process is alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(4194304)).toBe(false);
  });
});

describe('ensureGitignore', () => {
  it('ignores the session state but keeps golden images', () => {
    expect(ensureGitignore(resolvePaths(directory))).toBe(true);
    const written = fs.readFileSync(path.join(directory, '.gitignore'), 'utf8');
    expect(written).toContain('.clientdevbridge/*');
    expect(written).toContain('!.clientdevbridge/golden/');
  });

  it('is idempotent and preserves what was already there', () => {
    fs.writeFileSync(path.join(directory, '.gitignore'), 'build/\n');
    ensureGitignore(resolvePaths(directory));
    expect(ensureGitignore(resolvePaths(directory))).toBe(false);
    const written = fs.readFileSync(path.join(directory, '.gitignore'), 'utf8');
    expect(written).toContain('build/');
    expect(written.match(/\.clientdevbridge\/\*/g)).toHaveLength(1);
  });
});
