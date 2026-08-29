import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DETERMINISM_OPTIONS, pinOptions, renderInitScript } from '../src/initscript.js';

const baseOptions = {
  minecraftVersion: '1.21.1',
  loader: 'neoforge' as const,
  bridgeVersion: '1.0.0-DEV',
  port: 25599,
  evalEnabled: true,
  world: null,
  username: 'ClientDevBridge',
  width: 854,
  height: 480,
  jdwpPort: null,
  projectDir: '/tmp/project',
};

describe('renderInitScript', () => {
  it('injects the resolved coordinate for every supported loader plugin', () => {
    const script = renderInitScript(baseOptions);
    expect(script).toContain("'org.cyclops.clientdevbridge:clientdevbridge-1.21.1-neoforge:1.0.0-DEV'");
    // Both Loom plugin ids: it was renamed between the 1.21 and 26 toolchains.
    expect(script).toContain("'fabric-loom'");
    expect(script).toContain("'net.fabricmc.fabric-loom'");
    expect(script).toContain("'net.neoforged.gradle.userdev'");
    expect(script).toContain("'net.neoforged.moddev'");
  });

  it('defers the dependency additions until after evaluation', () => {
    // Adding to a Loom-managed configuration from a plugins.withId callback runs before the build
    // script's dependencies block, which makes Loom set Minecraft up too early.
    expect(renderInitScript(baseOptions)).toContain('project.afterEvaluate {');
  });

  it('looks the runtime configuration up rather than assuming one', () => {
    // Loom dropped modLocalRuntime and ModDevGradle added additionalRuntimeClasspath, so hardcoding
    // either one breaks on some supported Minecraft version.
    const script = renderInitScript(baseOptions);
    expect(script).toContain('firstExisting');
    expect(script).toContain("'modLocalRuntime', 'localRuntime', 'runtimeOnly'");
    expect(script).toContain("'additionalRuntimeClasspath', 'localRuntime', 'runtimeOnly'");
  });

  it('enables the bridge and pins the port', () => {
    const script = renderInitScript(baseOptions);
    expect(script).toContain("'-Dclientdevbridge.enabled=true'");
    expect(script).toContain("'-Dclientdevbridge.port=25599'");
    expect(script).toContain("'-Dclientdevbridge.eval=true'");
  });

  it('omits the eval flag when eval is off', () => {
    const script = renderInitScript({ ...baseOptions, evalEnabled: false });
    expect(script).not.toContain('clientdevbridge.eval');
  });

  it('adds quick-play only when a world was asked for', () => {
    expect(renderInitScript(baseOptions)).not.toContain('quickPlaySingleplayer');
    expect(renderInitScript({ ...baseOptions, world: 'testworld' })).toContain("'--quickPlaySingleplayer'");
  });

  it('adds the JDWP agent only when a debug port was asked for', () => {
    expect(renderInitScript(baseOptions)).not.toContain('agentlib:jdwp');
    expect(renderInitScript({ ...baseOptions, jdwpPort: 5005 })).toContain(
      'address=127.0.0.1:5005',
    );
  });

  it('configures the run through JavaExec, so one path covers both loaders', () => {
    const script = renderInitScript(baseOptions);
    expect(script).toContain('task instanceof JavaExec');
    expect(script).toContain("it.name == 'runClient'");
  });

  it('escapes quotes in paths rather than producing broken Groovy', () => {
    const script = renderInitScript({ ...baseOptions, projectDir: "/tmp/it's here" });
    expect(script).toContain("\\'");
  });
});

describe('pinOptions', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-options-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates options.txt with every determinism setting', () => {
    const result = pinOptions(directory);
    expect(result.created).toBe(true);
    const written = fs.readFileSync(path.join(directory, 'options.txt'), 'utf8');
    for (const [key, value] of Object.entries(DETERMINISM_OPTIONS)) {
      expect(written).toContain(`${key}:${value}`);
    }
  });

  it('keeps unrelated settings a developer had set', () => {
    fs.writeFileSync(path.join(directory, 'options.txt'), 'lang:nl_nl\nguiScale:3\n');
    const result = pinOptions(directory);
    expect(result.created).toBe(false);
    expect(result.changed).toContain('guiScale');

    const written = fs.readFileSync(path.join(directory, 'options.txt'), 'utf8');
    expect(written).toContain('lang:nl_nl');
    expect(written).toContain('guiScale:2');
  });

  it('is idempotent', () => {
    pinOptions(directory);
    const second = pinOptions(directory);
    expect(second.changed).toEqual([]);
  });
});
