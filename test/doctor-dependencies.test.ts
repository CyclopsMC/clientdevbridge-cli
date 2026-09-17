import { describe, expect, it } from 'vitest';
import { isGeneratedMinecraft, unresolvedModules } from '../src/commands/doctor.js';

/**
 * `gradle dependencies` exits 0 whether or not the modules resolve.
 *
 * It marks an unresolvable one and carries on, so reading only the exit status made this check
 * pass on exactly the failure it exists to catch: `doctor` said "the project resolves its compile
 * classpath", and the `start` after it died on `Username must not be null!`. The annotation is the
 * only evidence there is, so it is what gets read.
 *
 * The fixture below is real output, from Integrated Dynamics on master-26-lts without credentials.
 */
const FAILING_TREE = `
> Task :dependencies

compileClasspath - Compile classpath for source set 'main'.
+--- org.cyclops.cyclopscore:cyclopscore-26.1.2-neoforge:1.29.5-1012 FAILED
+--- org.cyclops.commoncapabilities:commoncapabilities-26.1.2-neoforge:2.11.4-344 FAILED
+--- net.neoforged:neoforge:26.1.2.22-beta
|    +--- net.sf.jopt-simple:jopt-simple:5.0.4
|    \\--- org.slf4j:slf4j-api:2.0.9
\\--- org.cyclops.integrateddynamicscompat:integrateddynamicscompat-26.1.2-neoforge:1.0.0-185 FAILED
`;

const HEALTHY_TREE = `
compileClasspath - Compile classpath for source set 'main'.
+--- net.neoforged:neoforge:21.1.228
|    \\--- org.slf4j:slf4j-api:2.0.9 (*)
\\--- org.cyclops.cyclopscore:cyclopscore-1.21.1-neoforge:1.30.3-1086 (n)
`;

describe('unresolved modules in a dependency tree', () => {
  it('are found even though gradle exited zero', () => {
    expect(unresolvedModules(FAILING_TREE)).toEqual([
      'org.cyclops.cyclopscore:cyclopscore-26.1.2-neoforge:1.29.5-1012',
      'org.cyclops.commoncapabilities:commoncapabilities-26.1.2-neoforge:2.11.4-344',
      'org.cyclops.integrateddynamicscompat:integrateddynamicscompat-26.1.2-neoforge:1.0.0-185',
    ]);
  });

  // `(n)` means not resolved *in this configuration*, and `(*)` means listed already. Neither is a
  // failure, and treating them as one would fail doctor on every healthy project.
  it('are not invented for a tree that resolves', () => {
    expect(unresolvedModules(HEALTHY_TREE)).toEqual([]);
  });

  it('are reported once even when a module fails under several parents', () => {
    const twice = 'a.b:c:1.0 FAILED\n|    \\--- a.b:c:1.0 FAILED\n';
    expect(unresolvedModules(twice)).toEqual(['a.b:c:1.0']);
  });
});

/**
 * A Minecraft that has not been built yet reads exactly like one that cannot be reached.
 *
 * Loom and ModDevGradle generate Minecraft locally and publish it into a repository under the
 * Gradle cache, so the first resolve after a version bump reports it FAILED and creates it, and
 * the next one finds it. Telling that apart from a real unresolvable dependency is what keeps
 * `doctor` from sending someone after credentials they do not need -- a bump to 26.3 failed the
 * fabric check on nothing worse than a cold cache.
 */
describe('isGeneratedMinecraft', () => {
  it('recognises the Minecraft a loader plugin builds for itself', () => {
    expect(isGeneratedMinecraft('net.minecraft:minecraft-merged-6974b2190e:26.3')).toBe(true);
    expect(isGeneratedMinecraft('net.minecraft:minecraft-merged-deobf:26.3')).toBe(true);
  });

  it('does not excuse anything else', () => {
    expect(isGeneratedMinecraft('org.cyclops.cyclopscore:cyclopscore-26.1.2-neoforge:1.29.5-1012')).toBe(false);
    expect(isGeneratedMinecraft('net.neoforged:neoforge:26.3.0.3-beta')).toBe(false);
    // Near miss: a group that merely starts the same way is not Minecraft.
    expect(isGeneratedMinecraft('net.minecraftforge:srgutils:1.0.0')).toBe(false);
  });
});
