import { describe, expect, it } from 'vitest';
import { findJavaHome, gradleJava, javaBinary, probeJava, resolveJavaHome } from '../src/java.js';

describe('javaBinary', () => {
  it('uses the PATH when there is no home', () => {
    expect(javaBinary(null)).toBe('java');
  });

  it('points into a home when there is one', () => {
    expect(javaBinary('/opt/jdk21')).toMatch(/^\/opt\/jdk21\/bin\/java(\.exe)?$/);
  });
});

describe('probeJava', () => {
  it('reads a version out of the JDK running these tests', () => {
    const probe = probeJava(null, 'PATH');
    expect(probe.major).toBeGreaterThanOrEqual(17);
    expect(probe.versionLine).toContain('version');
  });

  it('reports nothing usable for a home that holds no JDK', () => {
    const probe = probeJava('/nonexistent-jdk', 'test');
    expect(probe.major).toBeNull();
  });
});

describe('gradleJava', () => {
  it('names where it looked', () => {
    const probe = gradleJava();
    expect(['JAVA_HOME', 'PATH']).toContain(probe.source);
  });
});

describe('resolveJavaHome', () => {
  it('leaves a good enough environment alone', () => {
    const current = gradleJava();
    // Everything this project supports needs at least 21, so a machine that can run these tests
    // can always satisfy a requirement one below whatever it already has.
    const resolution = resolveJavaHome((current.major ?? 21) - 1);
    expect(resolution.substituted).toBe(false);
    expect(resolution.javaHome).toBe(current.home);
  });

  it('does not invent a JDK that is not installed', () => {
    const resolution = resolveJavaHome(999);
    expect(resolution.substituted).toBe(false);
    expect(findJavaHome(999)).toBeNull();
  });
});
