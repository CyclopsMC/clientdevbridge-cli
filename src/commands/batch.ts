import * as fs from 'node:fs';
import { CliError, EXIT_OK } from '../errors.js';
import { line, printJson } from '../output.js';
import { holdConnection } from './context.js';
import type { GlobalOptions } from './context.js';

export interface BatchOptions {
  readonly continueOnError: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
}

/** One command line from the script, with the source line number for reporting. */
interface Step {
  readonly number: number;
  readonly source: string;
  readonly tokens: readonly string[];
}

/**
 * Runs many CLI commands over a single connection.
 *
 * Every command in this CLI opens a socket, does one thing and closes it. That is right for a
 * command a person types and wrong for the fifty a script issues in a row, where the connect and
 * the process start cost more than the work. Batch mode holds one connection open and replays the
 * lines through the same argument parser the shell would, so no command needs to know it is in a
 * batch and nothing about their behaviour changes.
 *
 * The default is to stop at the first failure. A script that builds something -- place, open,
 * click, type -- is a sequence where step twelve is meaningless if step eleven did not happen, and
 * carrying on would bury the real error under a pile of consequential ones.
 */
export async function runBatch(
  globals: GlobalOptions,
  file: string,
  options: BatchOptions,
  run: (tokens: readonly string[]) => Promise<void>,
): Promise<number> {
  const steps = parse(read(file));
  if (steps.length === 0) {
    throw new CliError(`No commands in ${describe(file)}.`, 2,
      'Blank lines and lines starting with # are ignored; everything else is a command line.');
  }

  const release = await holdConnection(globals);
  let failures = 0;
  try {
    for (const step of steps) {
      if (!options.json && !options.quiet) {
        // Echoed the way a shell script with -x does, so a long batch's output can be read back
        // against the commands that produced it.
        line(`$ ${step.source}`);
      }
      const failure = await runStep(step, options, run);
      if (failure !== undefined) {
        failures++;
        if (!options.continueOnError) {
          throw new CliError(`${describe(file)} line ${step.number} failed: ${step.source}`,
            failure, 'The batch stopped there. Pass --continue-on-error to run the rest anyway.');
        }
      }
    }
  } finally {
    release();
  }
  return failures === 0 ? EXIT_OK : 1;
}

/**
 * Runs one step, and answers with its exit code if it failed.
 *
 * A command reports failure two ways -- by throwing, and by setting {@code process.exitCode} -- so
 * both are checked. The exit code is reset before each step, because it is process-wide state and
 * a failure in step three would otherwise still be set when step four succeeds.
 */
async function runStep(
  step: Step,
  options: BatchOptions,
  run: (tokens: readonly string[]) => Promise<void>,
): Promise<number | undefined> {
  process.exitCode = EXIT_OK;
  const captured = options.json ? capture() : undefined;
  let error: Error | undefined;
  try {
    await run(step.tokens);
  } catch (thrown) {
    error = thrown as Error;
  }
  const output = captured?.();
  const code = error !== undefined
    ? ((error as CliError).exitCode ?? 1)
    : (process.exitCode ?? EXIT_OK);
  process.exitCode = EXIT_OK;

  if (options.json) {
    printJson({
      line: step.number,
      command: step.source,
      ok: code === EXIT_OK,
      exitCode: code,
      output: output ?? '',
      error: error?.message ?? null,
    });
  } else if (error !== undefined) {
    process.stderr.write(`error: line ${step.number}: ${step.source}\n`);
    process.stderr.write(`error: ${error.message}\n`);
  }
  return code === EXIT_OK ? undefined : code;
}

/**
 * Diverts stdout so one step's output can be reported as a field rather than interleaved.
 *
 * Only stdout: a warning or an error message belongs on stderr in a batch exactly as it does
 * outside one, and swallowing it into a JSON field would hide it from anyone watching the run.
 */
function capture(): () => string {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = original;
    return chunks.join('');
  };
}

function read(file: string): string {
  if (file === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  if (!fs.existsSync(file)) {
    throw new CliError(`No such batch file: ${file}`, 2, "Pass '-' to read the commands from stdin.");
  }
  return fs.readFileSync(file, 'utf8');
}

function describe(file: string): string {
  return file === '-' ? 'stdin' : file;
}

function parse(text: string): Step[] {
  const steps: Step[] = [];
  text.split('\n').forEach((source, index) => {
    const trimmed = source.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      return;
    }
    steps.push({ number: index + 1, source: trimmed, tokens: tokenize(trimmed, index + 1) });
  });
  return steps;
}

/**
 * Splits a line the way a shell would, so a batch file can be written the way the commands are
 * typed: quotes group, a backslash escapes the next character, and nothing else is special.
 *
 * Deliberately not a shell: there is no expansion, no globbing and no substitution, because a
 * batch file is a list of commands for this CLI and not a program.
 */
export function tokenize(source: string, lineNumber = 0): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < source.length; index++) {
    const character = source[index] as string;
    if (character === '\\' && quote !== "'" && index + 1 < source.length) {
      current += source[++index];
      started = true;
    } else if (quote !== undefined && character === quote) {
      quote = undefined;
    } else if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
      started = true;
    } else if (quote === undefined && /\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote !== undefined) {
    throw new CliError(`Unterminated ${quote === '"' ? 'double' : 'single'} quote`
      + (lineNumber > 0 ? ` on line ${lineNumber}` : '') + `: ${source}`, 2);
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}
