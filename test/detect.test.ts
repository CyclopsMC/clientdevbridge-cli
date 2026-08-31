import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectGradleTask,
  detectLoaders,
  detectProject,
  detectRunDir,
  readGradleProperties,
} from '../src/detect.js';
import { CliError } from '../src/errors.js';

let directory: string;

function write(relative: string, contents: string): void {
  const full = path.join(directory, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-detect-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('readGradleProperties', () => {
  it('reads keys, skipping comments and blank lines', () => {
    write('gradle.properties', '# a comment\n\nminecraft_version=1.21.1\nmod_id = flopper \n');
    const properties = readGradleProperties(directory);
    expect(properties['minecraft_version']).toBe('1.21.1');
    expect(properties['mod_id']).toBe('flopper');
  });

  it('returns nothing rather than throwing when the file is missing', () => {
    expect(readGradleProperties(directory)).toEqual({});
  });
});

describe('detectLoaders', () => {
  it('recognises Loom as Fabric and ModDevGradle as NeoForge', () => {
    write('build.gradle', "id 'fabric-loom' version '1.7-SNAPSHOT'\nid 'net.neoforged.moddev' version '0.1.110'");
    expect(detectLoaders(directory).sort()).toEqual(['fabric', 'neoforge']);
  });

  it('recognises the Cyclops multiloader layout by its module directories', () => {
    write('loader-fabric/build.gradle', '');
    expect(detectLoaders(directory)).toContain('fabric');
  });

  it('finds nothing in an unrelated directory', () => {
    expect(detectLoaders(directory)).toEqual([]);
  });
});

describe('detectGradleTask', () => {
  it('uses the per-loader task in a multiloader layout', () => {
    write('loader-neoforge/build.gradle', '');
    expect(detectGradleTask(directory, 'neoforge').task).toBe(':loader-neoforge:runClient');
  });

  // Qualified, not bare: the init script takes the project path off the task to know which module
  // to inject the mod into, and a bare `runClient` gives it nothing to take off.
  it('falls back to the root runClient for a single-module mod', () => {
    expect(detectGradleTask(directory, 'fabric').task).toBe(':runClient');
  });
});

describe('detectRunDir', () => {
  it('assumes runs/client when nothing has run yet', () => {
    expect(detectRunDir(directory)).toBe(path.join(directory, 'runs', 'client'));
  });

  it('believes the directory a previous run left traces in', () => {
    // ModDevGradle 2, which the Minecraft 26 line builds on, runs the client in `run`.
    write('run/logs/latest.log', '');
    expect(detectRunDir(directory)).toBe(path.join(directory, 'run'));
  });

  it('ignores an options.txt, which the CLI writes itself', () => {
    write('run/options.txt', '');
    expect(detectRunDir(directory)).toBe(path.join(directory, 'runs', 'client'));
  });

  it('believes ModDevGradle over the convention on a cold checkout', () => {
    // Nothing has run yet, so the only evidence is the build itself. ModDevGradle 2 -- what the
    // Minecraft 26 line builds on -- runs the client in `run`, not `runs/client`.
    write('loader-neoforge/build.gradle', "plugins { id 'net.neoforged.moddev' }");
    expect(detectRunDir(path.join(directory, 'loader-neoforge'), directory, 'neoforge')).toBe(
      path.join(directory, 'loader-neoforge', 'run'),
    );
  });

  it('believes NeoGradle over the convention on a cold checkout', () => {
    write('loader-neoforge/build.gradle', "plugins { id 'net.neoforged.gradle.userdev' }");
    expect(detectRunDir(path.join(directory, 'loader-neoforge'), directory, 'neoforge')).toBe(
      path.join(directory, 'loader-neoforge', 'runs', 'client'),
    );
  });

  it("takes Loom's declared runDir on a cold checkout", () => {
    write('loader-fabric/build.gradle', "loom { runs { client { runDir('game') } } }");
    expect(detectRunDir(path.join(directory, 'loader-fabric'), directory, 'fabric')).toBe(
      path.join(directory, 'loader-fabric', 'game'),
    );
  });

  it('prefers what actually ran over what the build declares', () => {
    write('loader-neoforge/build.gradle', "plugins { id 'net.neoforged.moddev' }");
    write('loader-neoforge/runs/client/logs/latest.log', '');
    expect(detectRunDir(path.join(directory, 'loader-neoforge'), directory, 'neoforge')).toBe(
      path.join(directory, 'loader-neoforge', 'runs', 'client'),
    );
  });

  it('picks the most recently used one when a checkout has both', () => {
    write('runs/client/logs/latest.log', '');
    write('run/logs/latest.log', '');
    const older = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(directory, 'runs', 'client', 'logs'), older, older);
    expect(detectRunDir(directory)).toBe(path.join(directory, 'run'));
  });
});

describe('detectProject', () => {
  it('refuses a directory that is not a Gradle project, and says what to do', () => {
    expect(() => detectProject(directory)).toThrow(CliError);
    try {
      detectProject(directory);
    } catch (error) {
      expect((error as CliError).hint).toContain('--project');
    }
  });

  it('reads the Minecraft version and loader from a Cyclops-shaped checkout', () => {
    write('gradlew', '#!/bin/sh\n');
    write('gradle.properties', 'minecraft_version=1.21.1\n');
    write('loader-neoforge/build.gradle', '');
    const project = detectProject(directory);
    expect(project.minecraftVersion).toBe('1.21.1');
    expect(project.loader).toBe('neoforge');
    expect(project.gradleTask).toBe(':loader-neoforge:runClient');
  });

  it('prefers NeoForge when a checkout supports both, matching the Cyclops default', () => {
    write('gradlew', '#!/bin/sh\n');
    write('gradle.properties', 'minecraft_version=1.21.1\n');
    write('loader-fabric/build.gradle', '');
    write('loader-neoforge/build.gradle', '');
    expect(detectProject(directory).loader).toBe('neoforge');
  });

  it('honours an explicit --loader', () => {
    write('gradlew', '#!/bin/sh\n');
    write('gradle.properties', 'minecraft_version=1.21.1\n');
    write('loader-fabric/build.gradle', '');
    write('loader-neoforge/build.gradle', '');
    expect(detectProject(directory, { loader: 'fabric' }).loader).toBe('fabric');
  });

  it('rejects a --loader the project does not support', () => {
    write('gradlew', '#!/bin/sh\n');
    write('gradle.properties', 'minecraft_version=1.21.1\n');
    write('loader-neoforge/build.gradle', '');
    expect(() => detectProject(directory, { loader: 'fabric' })).toThrow(/does not appear to support/);
  });

  it('says to pass --mc-version when gradle.properties has none', () => {
    write('gradlew', '#!/bin/sh\n');
    write('loader-neoforge/build.gradle', '');
    try {
      detectProject(directory);
      expect.unreachable('should have thrown');
    } catch (error) {
      // The message says what is wrong; the hint says what to do about it.
      expect((error as CliError).message).toMatch(/Could not determine the Minecraft version/);
      expect((error as CliError).hint).toContain('--mc-version');
    }
  });
});
