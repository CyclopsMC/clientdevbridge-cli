import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { commandExists, planDisplay } from '../src/xvfb.js';

/**
 * The environment a headless client is given.
 *
 * Worth pinning because getting it wrong does not look like a configuration problem: the client
 * builds, launches, and then dies inside its own renderer, and the only evidence is a stack trace
 * in a game log. Minecraft 26.3 needs SDL on EGL to have a display at all.
 */
describe('planDisplay', () => {
  const previousDisplay = process.env['DISPLAY'];

  beforeEach(() => {
    delete process.env['DISPLAY'];
  });

  afterEach(() => {
    if (previousDisplay === undefined) {
      delete process.env['DISPLAY'];
    } else {
      process.env['DISPLAY'] = previousDisplay;
    }
  });

  it.skipIf(process.platform !== 'linux' || !commandExists('xvfb-run'))(
    'runs a headless client under xvfb with software GL and SDL on EGL',
    () => {
      const plan = planDisplay('gradlew', { headed: false, width: 854, height: 480 });
      expect(plan.command).toBe('xvfb-run');
      expect(plan.env['LIBGL_ALWAYS_SOFTWARE']).toBe('1');
      // Xvfb offers no sRGB-capable GLX config, and 26.3 asks for one. Without this the client
      // fails to create any render backend and never opens a window.
      expect(plan.env['SDL_VIDEO_FORCE_EGL']).toBe('1');
    },
  );

  it('leaves an existing display alone, and sets nothing on it', () => {
    process.env['DISPLAY'] = ':42';
    const plan = planDisplay('gradlew', { headed: false, width: 854, height: 480 });
    expect(plan.command).toBe('gradlew');
    expect(plan.prefixArgs).toEqual([]);
    expect(plan.env).toEqual({});
  });
});
