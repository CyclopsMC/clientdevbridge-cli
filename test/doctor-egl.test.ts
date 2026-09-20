import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EGL_LIBRARIES, missingEglLibraries } from '../src/commands/doctor.js';

/**
 * `doctor` green-lit a machine the client could not start on.
 *
 * Minecraft 26.3 draws through SDL, which loads EGL by name at runtime. The GL preflight only
 * looked at the Mesa DRI drivers, so a box with `libgl1-mesa-dri` and no `libEGL.so.1` reported
 * "Everything checks out" and then the client failed to create an OpenGL backend, failed to create
 * a Vulkan one, and exited — a failure with nothing in it that points back at the environment.
 */
describe('missingEglLibraries', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-egl-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names every EGL library that is absent', () => {
    expect(missingEglLibraries([dir])).toEqual(['libEGL.so.1', 'libEGL_mesa.so.0']);
  });

  it('is satisfied once both are installed', () => {
    for (const library of EGL_LIBRARIES) {
      fs.writeFileSync(path.join(dir, library.file), '');
    }
    expect(missingEglLibraries([dir])).toEqual([]);
  });

  it('still reports the missing vendor when only the loader is installed', () => {
    // The two fail differently and this is the half that is easy to miss: SDL dlopens
    // libEGL.so.1 and succeeds, then initialising the display fails later because there is no
    // vendor behind it. Reporting "EGL is present" there would be true and useless.
    fs.writeFileSync(path.join(dir, 'libEGL.so.1'), '');
    expect(missingEglLibraries([dir])).toEqual(['libEGL_mesa.so.0']);
  });

  it('accepts a library found in any of the directories it is given', () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-egl-alt-'));
    try {
      fs.writeFileSync(path.join(dir, 'libEGL.so.1'), '');
      fs.writeFileSync(path.join(second, 'libEGL_mesa.so.0'), '');
      expect(missingEglLibraries([dir, second])).toEqual([]);
    } finally {
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('names a package for each library, so the report can say what to install', () => {
    // The check is only useful if it ends in a command. Every library needs a package or the
    // advice is "something is missing", which is where this started.
    for (const library of EGL_LIBRARIES) {
      expect(library.pkg).not.toBe('');
    }
  });
});
