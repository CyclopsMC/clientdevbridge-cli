#!/usr/bin/env node
import { Command } from 'commander';
import { CliError, EXIT_OK, EXIT_PROTOCOL, EXIT_SESSION, ProtocolError } from './errors.js';
import type { GlobalOptions } from './commands/context.js';
import { runRestart, runStart, runStatus, runStop, START_DEFAULTS } from './commands/lifecycle.js';
import { runLogs, runScreenshot, runWait } from './commands/inspect.js';
import { runDoctor } from './commands/doctor.js';

const program = new Command();

program
  .name('clientdevbridge')
  .description(
    'Launch and drive a Minecraft dev client from the shell, for coding agents.\n' +
      'Screenshots are written to files and their paths printed; open them with your agent\'s file-reading tool.',
  )
  .version('0.1.0')
  .option('-p, --project <dir>', 'the mod project to drive', process.cwd())
  .option('--json', 'print the raw protocol result instead of readable text', false)
  .option('-q, --quiet', 'print only the essential output', false)
  .showHelpAfterError();

function globals(): GlobalOptions {
  const options = program.opts();
  return { project: options['project'], json: options['json'], quiet: options['quiet'] };
}

program
  .command('start')
  .description('launch the dev client and wait until it answers')
  .option('--loader <loader>', 'fabric or neoforge (default: detected from the applied Gradle plugins)')
  .option('--mc-version <version>', "Minecraft version (default: gradle.properties 'minecraft_version')")
  .option('--clientdevbridge-version <version>', 'pin a specific ClientDevBridge mod build')
  .option('--world <name>', 'join this singleplayer world on startup, via --quickPlaySingleplayer')
  .option('--headed', 'use a real window even when $DISPLAY is unset', false)
  .option('--port <port>', 'localhost port for the bridge', START_DEFAULTS.port)
  .option('--timeout <seconds>', 'how long to wait for the client to come up', START_DEFAULTS.timeout)
  .option('--width <px>', 'client window width', START_DEFAULTS.width)
  .option('--height <px>', 'client window height', START_DEFAULTS.height)
  .option('--jdwp-port <port>', 'also open a JDWP debug port, required by hotswap')
  .option('--gradle-args <args>', 'extra arguments to pass to Gradle, space separated')
  .option('--no-eval', 'do not enable the eval escape hatch')
  .option('--no-pin-options', 'do not pin the determinism settings in options.txt')
  .action(async (options) => runStart(globals(), options));

program
  .command('stop')
  .description('kill the dev client and its whole process group')
  .action(async () => runStop(globals()));

program
  .command('status')
  .description('report whether a client is running, and what it is showing')
  .action(async () => runStatus(globals()));

program
  .command('restart')
  .description('stop, then start again with the same options')
  .option('--loader <loader>', 'fabric or neoforge')
  .option('--mc-version <version>', 'Minecraft version')
  .option('--clientdevbridge-version <version>', 'pin a specific ClientDevBridge mod build')
  .option('--world <name>', 'join this singleplayer world on startup')
  .option('--headed', 'use a real window even when $DISPLAY is unset', false)
  .option('--port <port>', 'localhost port for the bridge', START_DEFAULTS.port)
  .option('--timeout <seconds>', 'how long to wait for the client to come up', START_DEFAULTS.timeout)
  .option('--width <px>', 'client window width', START_DEFAULTS.width)
  .option('--height <px>', 'client window height', START_DEFAULTS.height)
  .option('--jdwp-port <port>', 'also open a JDWP debug port, required by hotswap')
  .option('--gradle-args <args>', 'extra arguments to pass to Gradle, space separated')
  .option('--no-eval', 'do not enable the eval escape hatch')
  .option('--no-pin-options', 'do not pin the determinism settings in options.txt')
  .action(async (options) => runRestart(globals(), options));

program
  .command('screenshot')
  .description('capture the framebuffer to a PNG and print its path')
  .option('--name <name>', 'file name to write (default: a timestamp)')
  .option('--region <x,y,w,h>', 'capture only this rectangle')
  .option('--space <space>', 'coordinate space for --region: gui or pixel', 'gui')
  .option('--scale <factor>', 'rescale the captured image')
  .option('--after-ticks <n>', 'wait this many client ticks before capturing')
  .action(async (options) => runScreenshot(globals(), options));

program
  .command('logs')
  .description("show the game's recent log lines, or Gradle's with --gradle")
  .option('-n, --lines <n>', 'how many lines to show', '200')
  .option('--filter <regex>', 'only lines matching this regular expression')
  .option('--level <level>', 'lowest severity to show: trace, debug, info, warn, error, fatal', 'info')
  .option('--gradle', 'read .clientdevbridge/gradle.log instead of the in-game log', false)
  .action(async (options) => runLogs(globals(), options));

program
  .command('wait')
  .description('wait for game ticks to pass')
  .option('--ticks <n>', 'number of client ticks to wait', '1')
  .action(async (options) => runWait(globals(), options));

program
  .command('doctor')
  .description('check that this machine can build and launch a dev client')
  .option('--no-network', 'skip the network reachability probes')
  .action(async (options) => {
    const code = await runDoctor(globals(), options);
    process.exitCode = code;
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof ProtocolError) {
      process.stderr.write(`error: ${error.message}\n`);
      if (error.hint !== undefined) {
        process.stderr.write(`${error.hint}\n`);
      }
      process.exitCode = EXIT_PROTOCOL;
      return;
    }
    if (error instanceof CliError) {
      process.stderr.write(`error: ${error.message}\n`);
      if (error.hint !== undefined) {
        process.stderr.write(`${error.hint}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = EXIT_SESSION;
    return;
  }
  process.exitCode = process.exitCode ?? EXIT_OK;
}

void main();
