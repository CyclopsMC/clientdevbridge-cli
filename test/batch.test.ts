import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/commands/batch.js';
import { CliError } from '../src/errors.js';

describe('tokenize', () => {
  it('splits on whitespace the way a shell does', () => {
    expect(tokenize('click --at 10,20')).toEqual(['click', '--at', '10,20']);
  });

  it('keeps a quoted argument together', () => {
    expect(tokenize('set-text /root/children[3] "two words"')).toEqual([
      'set-text',
      '/root/children[3]',
      'two words',
    ]);
  });

  it('leaves a single-quoted argument unescaped, as a shell does', () => {
    expect(tokenize("eval 'a\\b'")).toEqual(['eval', 'a\\b']);
  });

  it('honours a backslash escape outside single quotes', () => {
    expect(tokenize('type a\\ b')).toEqual(['type', 'a b']);
  });

  it('produces an empty argument for an empty quoted string', () => {
    // set-text with an empty value is how a field is cleared, so "" has to survive tokenizing.
    expect(tokenize('set-text field ""')).toEqual(['set-text', 'field', '']);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenize('  give   stone   64  ')).toEqual(['give', 'stone', '64']);
  });

  it('refuses an unterminated quote rather than guessing where it ends', () => {
    expect(() => tokenize('type "unclosed', 4)).toThrow(CliError);
    expect(() => tokenize('type "unclosed', 4)).toThrow(/line 4/);
  });

  it('keeps a negative coordinate intact', () => {
    expect(tokenize('teleport -10 5 -10')).toEqual(['teleport', '-10', '5', '-10']);
  });
});
