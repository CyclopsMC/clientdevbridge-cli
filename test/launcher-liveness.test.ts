import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fatalStartupError, waitForHandshake } from '../src/launcher.js';
import type { Session } from '../src/session.js';
import { EXIT_NOT_READY } from '../src/errors.js';
import type { CliError } from '../src/errors.js';

/**
 * `start` called a crash loop healthy progress.
 *
 * Porting CyclopsCore to 26.3 on a headless runner with no EGL, `start` printed the same unchanged
 * log tail every 15s for the full 300s and then concluded "Gradle is running and has written to
 * the log throughout the wait, so nothing has failed" — while the log already held a fatal
 * BackendCreationException. Bytes were being written, so the size test was satisfied; they were
 * the same stack trace over and over.
 *
 * The excerpt below is from that run.
 */
const CRASH_LOOP = `
[14:27:42] [Render thread/INFO] [minecraft/Minecraft]: Backend library: LWJGL version 3.4.3+4
[14:27:43] [Render thread/ERROR] [minecraft/Minecraft]: Failed to create backend OpenGL
com.mojang.renderpearl.api.device.BackendCreationException: OpenGL is not supported: Could not load EGL library
\tat TRANSFORMER/minecraft@26.3/com.mojang.renderpearl.backend.opengl.GlBackend.loadLibrary(GlBackend.java:61)
\tat net.neoforged.devlaunch.Main.main(Main.java:57)
[14:27:43] [Render thread/ERROR] [minecraft/Minecraft]: Failed to create backend Vulkan
com.mojang.renderpearl.api.device.BackendCreationException: Vulkan is not supported: Installed Vulkan doesn't implement the VK_KHR_surface extension
\tat TRANSFORMER/minecraft@26.3/com.mojang.renderpearl.backend.vulkan.VulkanBackend.loadLibrary(VulkanBackend.java:75)
\tat net.neoforged.devlaunch.Main.main(Main.java:57)
`;

/** A slow first build, which is the case that must keep being told to wait. */
const HEALTHY_BUILD = `
> Task :loader-neoforge:neoFormRecompile
> Task :loader-neoforge:downloadAssets
[14:27:22] [main/INFO] [ne.ne.fm.lo.FMLLoader/]: Built game content classloader in 20ms
[14:27:42] [resourceLoad/INFO] [minecraft/UnihexProvider]: Found unifont_jp_patch-17.0.01.hex, loading
`;

describe('fatalStartupError', () => {
  it('finds the renderer failure that made a crash loop look like progress', () => {
    const found = fatalStartupError(CRASH_LOOP);
    expect(found).not.toBeNull();
    expect(found).toContain('Could not load EGL library');
  });

  it('reports every backend that failed, because the first one is the actionable one', () => {
    // OpenGL failing for want of EGL is fixable; Vulkan being absent on a headless box is normal.
    // Quoting only one of them would either hide the fix or lead with the red herring.
    const found = fatalStartupError(CRASH_LOOP) ?? '';
    expect(found).toContain('OpenGL is not supported');
    expect(found).toContain('Vulkan is not supported');
  });

  it('says nothing about a build that is merely slow', () => {
    expect(fatalStartupError(HEALTHY_BUILD)).toBeNull();
  });

  it('ignores the exceptions a healthy Minecraft start logs anyway', () => {
    // The expensive mistake is the other direction: a log full of mod warnings and declined
    // mixins must not read as a dead client, or every slow build becomes a false failure.
    const noisy = `
[14:27:31] [main/WARN] [mixin/]: Method overwrite conflict for getFov, skipping mixin
[14:27:33] [main/ERROR] [ne.ne.fm.ja.JarJar/]: Failed to load optional dependency
java.io.FileNotFoundException: assets/examplemod/lang/fr_fr.json
\tat java.base/java.io.FileInputStream.open0(Native Method)
[14:27:35] [Render thread/WARN] [minecraft/ShaderInstance]: Shader rendertype_entity could not find sampler named Sampler2
`;
    expect(fatalStartupError(noisy)).toBeNull();
  });

  it('finds a JVM crash', () => {
    expect(
      fatalStartupError('# A fatal error has been detected by the Java Runtime Environment:\n# SIGSEGV'),
    ).toContain('A fatal error has been detected');
  });

  it('finds a launcher that threw', () => {
    expect(fatalStartupError('Exception in thread "main" java.lang.NoSuchMethodError: foo')).toContain(
      'NoSuchMethodError',
    );
  });

  it('quotes a repeated failure once, not once per loop', () => {
    // The log this exists for repeats the same trace for minutes. Quoting all of it would bury
    // the message under itself.
    const repeated = Array.from({ length: 50 }, () => CRASH_LOOP).join('\n');
    expect((fatalStartupError(repeated) ?? '').split('\n')).toHaveLength(2);
  });
});

/**
 * The decision the wait makes when it runs out, which is where the reported bug lived.
 *
 * A pid that does not exist and a one-millisecond timeout put the wait straight into that
 * decision without booting anything: the point is what it concludes from the log, and a machine
 * where Minecraft works cannot produce the log that matters.
 */
describe('waitForHandshake, when the wait runs out', () => {
  let dir = '';
  let log = '';

  const session = (): Session =>
    ({
      version: 1,
      // This test process: alive, so the wait reaches the decision at the end rather than the
      // "Gradle exited before the client came up" branch. That branch quotes the log tail, which
      // contains the very strings these tests look for -- an earlier version of this test passed
      // against it while the code under test never ran.
      pid: process.pid,
      pgid: process.pid,
      // Nothing is listening, so the loop never reaches a handshake.
      port: 59_999,
      loader: 'neoforge',
      mcVersion: '26.3',
      bridgeVersion: '1.0.0-DEV',
      projectDir: dir,
      gradleTask: ':loader-neoforge:runClient',
      startedAt: new Date().toISOString(),
      world: null,
      headed: false,
      display: null,
      jdwpPort: null,
    }) as Session;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-wait-'));
    log = path.join(dir, 'gradle.log');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails with the exception the log already held, instead of advising a longer wait', async () => {
    fs.writeFileSync(log, CRASH_LOOP);
    const error = await waitForHandshake(session(), log, 1).catch((thrown: CliError) => thrown);

    // Named explicitly so this cannot pass through some other branch that happens to quote the
    // log tail; the tail contains these strings too.
    expect((error as Error).message).toContain('The client failed to start');
    expect((error as Error).message).toContain('Could not load EGL library');
    // The sentence that was wrong: a fatal error was in the log the whole time.
    expect((error as Error).message).not.toContain('nothing has failed');
  });

  it('does not exit 3, which means "not ready yet"', async () => {
    fs.writeFileSync(log, CRASH_LOOP);
    const error = await waitForHandshake(session(), log, 1).catch((thrown: CliError) => thrown);

    // A crash loop is a failure, and a caller that branches on exit code 3 would go back to
    // waiting for a client that is never coming.
    expect((error as CliError).exitCode).not.toBe(EXIT_NOT_READY);
  });

  it('points at the check that would have caught it', async () => {
    fs.writeFileSync(log, CRASH_LOOP);
    const error = await waitForHandshake(session(), log, 1).catch((thrown: CliError) => thrown);

    expect((error as CliError).hint ?? '').toContain('doctor');
  });

  it('still tells a genuinely slow build to wait, which is what exit 3 is for', async () => {
    // The regression this change could have caused. A cold toolchain cache takes fifteen to
    // twenty minutes and the wait expires long before that with nothing wrong; turning that into
    // a failure would be worse than the bug being fixed.
    fs.writeFileSync(log, HEALTHY_BUILD);
    const growing = setInterval(() => fs.appendFileSync(log, `> Task :step${Date.now()}\n`), 100);
    try {
      const error = await waitForHandshake(session(), log, 1_200).catch((thrown: CliError) => thrown);

      expect((error as CliError).exitCode).toBe(EXIT_NOT_READY);
      expect((error as Error).message).toContain('nothing has failed');
    } finally {
      clearInterval(growing);
    }
  });
});
