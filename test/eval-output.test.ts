import { describe, expect, it } from 'vitest';
import { isDescribedObject } from '../src/commands/input.js';

/**
 * The mod describes anything it cannot map cleanly to JSON as `{ type, toString }`. Detecting that
 * by asking whether the value has a `toString` key is wrong, because every JavaScript object
 * inherits one — which made `eval` print `function toString() { [native code] }` for every array
 * and object it was ever given.
 */
describe('isDescribedObject', () => {
  it('recognises the described-object shape the mod sends', () => {
    expect(isDescribedObject({ type: 'com.mojang.blaze3d.platform.Window', toString: 'Window@1' })).toBe(true);
  });

  it('does not fire for a plain object, which inherits toString', () => {
    expect(isDescribedObject({ x: 1, y: 2 })).toBe(false);
    expect('toString' in { x: 1 }).toBe(true);
  });

  it('does not fire for arrays, numbers, strings or null', () => {
    expect(isDescribedObject([1, 2, 3])).toBe(false);
    expect(isDescribedObject(4)).toBe(false);
    expect(isDescribedObject('hi')).toBe(false);
    expect(isDescribedObject(null)).toBe(false);
    expect(isDescribedObject(undefined)).toBe(false);
  });

  it('does not fire when only one half of the shape is present', () => {
    expect(isDescribedObject({ type: 'a.B' })).toBe(false);
    expect(isDescribedObject({ toString: 'x' })).toBe(false);
    expect(isDescribedObject({ type: 1, toString: 'x' })).toBe(false);
  });
});
