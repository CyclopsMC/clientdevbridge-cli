import { describe, expect, it } from 'vitest';
import { ARTIFACT_LINES, artifactId, coordinate, findLine, unsupportedMessage } from '../src/artifacts.js';

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
