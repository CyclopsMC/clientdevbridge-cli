import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectGradleTask, detectProject, projectPathOf } from '../src/detect.js';
import { renderInitScript } from '../src/initscript.js';

/**
 * The single-module layout, which is what most mod repositories actually are.
 *
 * This whole file exists because of one bug: `detectGradleTask` answered a bare `runClient` with no
 * leading colon, the launcher stripped the task name with a pattern that requires one, and the
 * injection target became the literal string `runClient`. No Gradle project has that path, so the
 * init script's `if (project.path != target) return` guard returned early for *every* project and
 * nothing was injected at all — on a real mod repo the client booted as a plain dev client and the
 * bridge never answered, with nothing naming the cause.
 *
 * Both e2e fixtures are multiloader, so nothing caught it. These tests are the cheap half of the
 * guard; the assertion that matters is the last one, which pins the target the init script is given.
 */
let directory: string;

function write(relative: string, contents: string): void {
  const full = path.join(directory, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function singleModuleProject(): void {
  write('gradle.properties', 'minecraft_version=1.21.1\nneoforge_version=21.1.228\n');
  write('build.gradle', "plugins { id 'net.neoforged.gradle.userdev' version '7.0.170' }\n");
  write('settings.gradle', "rootProject.name = 'example'\n");
  write('gradlew', '#!/bin/sh\n');
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-single-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('projectPathOf', () => {
  it('takes the module off a qualified task', () => {
    expect(projectPathOf(':loader-neoforge:runClient')).toBe(':loader-neoforge');
  });

  it('answers the root project for a root task', () => {
    expect(projectPathOf(':runClient')).toBe(':');
  });

  it('answers the root project for an unqualified task, rather than the task name', () => {
    // The old code returned 'runClient' here, which is not a project path at all.
    expect(projectPathOf('runClient')).toBe(':');
  });

  it('handles a nested module', () => {
    expect(projectPathOf(':a:b:runClient')).toBe(':a:b');
  });
});

describe('detectGradleTask', () => {
  it('qualifies the task for a single-module project', () => {
    singleModuleProject();
    expect(detectGradleTask(directory, 'neoforge').task).toBe(':runClient');
  });

  it('still names the module for a multiloader project', () => {
    singleModuleProject();
    fs.mkdirSync(path.join(directory, 'loader-neoforge'), { recursive: true });
    expect(detectGradleTask(directory, 'neoforge').task).toBe(':loader-neoforge:runClient');
  });
});

describe('the init script for a single-module project', () => {
  it('targets the root project, so the guard matches something', () => {
    singleModuleProject();
    const project = detectProject(directory);
    const script = renderInitScript({
      dependency: 'org.cyclops.clientdevbridge:clientdevbridge-1.21.1-neoforge:1.0.0',
      loader: 'neoforge',
      port: 25599,
      evalEnabled: true,
      world: null,
      username: 'ClientDevBridge',
      width: 854,
      height: 480,
      jdwpPort: null,
      projectDir: directory,
      targetProjectPath: projectPathOf(project.gradleTask),
    });
    expect(script).toContain("def clientDevBridgeTarget = ':'");
    // The failure this file exists for: a target no project can ever equal.
    expect(script).not.toContain("clientDevBridgeTarget = 'runClient'");
  });
});
