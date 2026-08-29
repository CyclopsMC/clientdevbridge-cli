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
  targetProjectPath: ':loader-neoforge',
};

describe('renderInitScript', () => {
  it('injects the resolved coordinate for the loader being launched', () => {
    expect(renderInitScript(baseOptions)).toContain(
      "'org.cyclops.clientdevbridge:clientdevbridge-1.21.1-neoforge:1.0.0-DEV'",
    );
    expect(renderInitScript({ ...baseOptions, loader: 'fabric' })).toContain(
      "'org.cyclops.clientdevbridge:clientdevbridge-1.21.1-fabric:1.0.0-DEV'",
    );
  });

  it('never asks Gradle which loader plugin is applied', () => {
    // Registering a plugins.withId callback for Loom's id -- even an empty one -- makes Loom 1.15
    // set Minecraft up before the build script's dependencies block has run, and the build fails
    // with "Configuration 'mappings' has no dependencies". The CLI already knows the loader.
    for (const loader of ['fabric', 'neoforge'] as const) {
      expect(renderInitScript({ ...baseOptions, loader })).not.toContain('project.plugins.withId(');
    }
  });

  it('defers the dependency additions until after evaluation', () => {
    // Adding to a Loom-managed configuration from a plugins.withId callback runs before the build
    // script's dependencies block, which makes Loom set Minecraft up too early.
    expect(renderInitScript(baseOptions)).toContain('project.afterEvaluate {');
  });

  it('looks the Loom runtime configuration up rather than assuming one', () => {
    // Loom dropped modLocalRuntime between the 1.21 and 26 toolchains, so hardcoding it breaks.
    const script = renderInitScript({ ...baseOptions, loader: 'fabric' });
    expect(script).toContain('firstExisting');
    expect(script).toContain("'modLocalRuntime', 'localRuntime', 'runtimeOnly'");
  });

  it('puts a NeoForge mod on the plain runtime classpath', () => {
    // ModDevGradle 2 rejects additionalRuntimeClasspath outright and both NeoForge plugins find
    // mods on the runtime classpath, so there is nothing to look up on that side.
    const script = renderInitScript(baseOptions);
    expect(script).toContain("project.dependencies.add('runtimeOnly', clientDevBridgeDependency)");
    expect(script).not.toContain('firstExisting');
  });

  it('only injects into the module being launched', () => {
    // Injecting into a multiloader repo's other loader modules is pointless, and on the Minecraft
    // 26 toolchain it makes Loom set Minecraft up before its mappings are populated.
    const script = renderInitScript(baseOptions);
    expect(script).toContain("def clientDevBridgeTarget = ':loader-neoforge'");
    expect(script).toContain('project.path != clientDevBridgeTarget');
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

  it('adds program arguments through a provider so they stay last', () => {
    // Gradle emits every static argument before every provider's, and ModDevGradle passes the main
    // class through a provider: appending statically makes the launcher treat our first argument
    // as the main class.
    expect(renderInitScript(baseOptions)).toContain('task.argumentProviders.add(');
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
