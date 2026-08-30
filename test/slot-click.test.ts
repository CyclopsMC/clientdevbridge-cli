import { describe, expect, it } from 'vitest';
import { CLICK_TYPES, runSlotClick } from '../src/commands/input.js';
import { CliError } from '../src/errors.js';

const globals = { project: process.cwd(), json: false, quiet: true };

describe('slot-click argument checks', () => {
  // These run before anything connects, which is the point: a typo should not need a client.
  it('refuses a click type Minecraft does not have, and names the ones it does', async () => {
    const thrown = await runSlotClick(globals, '0', { type: 'shift', button: '0' }).catch((error) => error);
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).message).toContain("'shift' is not a click type");
    // The list belongs in the hint, which is what the CLI prints on the second line.
    expect((thrown as CliError).hint).toContain('quick_move');
  });

  it('refuses a call with neither a slot nor a point', async () => {
    await expect(runSlotClick(globals, undefined, { type: 'pickup', button: '0' })).rejects.toThrow(
      /slot index or --at/,
    );
  });

  it('accepts the type names the protocol documents, in any case', async () => {
    // Not a connection test: it only has to get past the guard, which a bad name would not.
    await expect(runSlotClick(globals, '0', { type: 'QUICK_MOVE', button: '0' })).rejects.not.toThrow(
      /is not a click type/,
    );
  });

  it('lists exactly the seven operations a container click can be', () => {
    expect([...CLICK_TYPES]).toEqual([
      'pickup',
      'quick_move',
      'swap',
      'clone',
      'throw',
      'quick_craft',
      'pickup_all',
    ]);
  });
});
