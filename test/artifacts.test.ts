import { describe, expect, it } from 'vitest';
import { ARTIFACT_LINES, artifactId, coordinate, findLine, unsupportedMessage, usesSdl } from '../src/artifacts.js';

describe('artifact resolution', () => {
  it('maps the Minecraft versions this branch supports to its own line', () => {
    expect(findLine('1.21.1')?.branch).toBe('master-1.21-lts');
    expect(findLine('1.21')?.branch).toBe('master-1.21-lts');
  });

  it('maps the 26 LTS point releases to the LTS branch, and anything newer to the trunk one', () => {
    expect(findLine('26.1.2')?.branch).toBe('master-26-lts');
    expect(findLine('26.1')?.branch).toBe('master-26-lts');
    expect(findLine('26.2')?.branch).toBe('master-26');
    expect(findLine('26.3.1')?.branch).toBe('master-26');
  });

  it('returns nothing for a version no branch covers', () => {
    expect(findLine('1.20.1')).toBeUndefined();
    expect(findLine('nonsense')).toBeUndefined();
  });

  it('names artifacts the way CyclopsCore and Flopper do', () => {
    expect(artifactId('1.21.1', 'neoforge')).toBe('clientdevbridge-1.21.1-neoforge');
    expect(coordinate('1.21.1', 'fabric', '1.0.0')).toBe(
      'org.cyclops.clientdevbridge:clientdevbridge-1.21.1-fabric:1.0.0',
    );
  });

  it('explains what to do when no branch covers the version', () => {
    const message = unsupportedMessage('1.20.1');
    expect(message).toContain('1.20.1');
    expect(message).toContain('--clientdevbridge-version');
    for (const line of ARTIFACT_LINES) {
      expect(message).toContain(line.branch);
    }
  });
});

/**
 * 26.3 replaced GLFW with SDL, which changed what a machine must have installed before the client
 * can render at all. The version is the only thing the CLI can decide that from, so the boundary is
 * worth pinning: warning a 26.2 user about a library they do not need is as wrong as staying quiet
 * for a 26.3 user who does.
 */
describe('usesSdl', () => {
  it('is true from 26.3 onwards', () => {
    expect(usesSdl('26.3')).toBe(true);
    expect(usesSdl('26.3.1')).toBe(true);
    expect(usesSdl('26.4')).toBe(true);
    expect(usesSdl('27.0')).toBe(true);
  });

  it('is false for every GLFW-era version', () => {
    expect(usesSdl('26.2')).toBe(false);
    expect(usesSdl('26.1.2')).toBe(false);
    expect(usesSdl('1.21.1')).toBe(false);
    // Shorter than the version it is compared against: "26" is 26.0, which is older than 26.3.
    expect(usesSdl('26')).toBe(false);
  });

  it('says false for a version it cannot read, rather than guessing', () => {
    // A snapshot or a fork's own string. Staying quiet is the cheaper mistake: `start` still
    // fails with the real renderer error, whereas a wrong FAIL sends someone installing packages
    // that were never the problem.
    expect(usesSdl('25w14a')).toBe(false);
    expect(usesSdl('')).toBe(false);
    expect(usesSdl('not-a-version')).toBe(false);
  });
});
