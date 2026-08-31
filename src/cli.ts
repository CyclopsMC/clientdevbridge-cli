#!/usr/bin/env node
import * as fs from 'node:fs';
import { Command } from 'commander';
import { packageVersion } from './version.js';
import { CliError, EXIT_OK, EXIT_PROTOCOL, EXIT_SESSION, ProtocolError } from './errors.js';
import type { GlobalOptions } from './commands/context.js';
import { runRestart, runStart, runStatus, runStop, START_DEFAULTS } from './commands/lifecycle.js';
import { runLogs, runScreenshot } from './commands/inspect.js';
import { runDoctor } from './commands/doctor.js';
import {
  runBlock,
  runBreak,
  runCommand,
  runGive,
  runInventory,
  runLook,
  runRegistry,
  runSetblock,
  runUse,
  runTeleport,
  runWorldLeave,
  runWorldList,
  runWorldLoad,
  runWalkTo,
  runWorldReset,
} from './commands/world.js';
import {
  runClick,
  runCloseScreen,
  runDrag,
  runEval,
  runHoldKey,
  runKey,
  runMouseMove,
  runOpenGui,
  runUseItem,
  runScroll,
  runSetText,
  runSlotClick,
  runType,
  runWaitFor,
} from './commands/input.js';
import { runFind, runInspectGui, runSnapshot, runTooltip } from './commands/snapshot.js';
import { runCompare, runResize } from './commands/compare.js';
import { runHotswap } from './commands/hotswap.js';
import { runBatch } from './commands/batch.js';

const program = new Command();

program
  .name('clientdevbridge')
  .description(
    'Launch and drive a Minecraft dev client from the shell, for coding agents.\n' +
      'Screenshots are written to files and their paths printed; open them with your agent\'s file-reading tool.',
  )
  .version(packageVersion())
  .option('-p, --project <dir>', 'the mod project to drive', process.cwd())
  .option('--json', 'print the raw protocol result instead of readable text', false)
  .option('-q, --quiet', 'print only the essential output', false)
  .showHelpAfterError();

function globals(): GlobalOptions {
  const options = program.opts();
  const project = String(options['project']);
  // Checked once, here, rather than in each command: a --project that does not exist otherwise
  // reads as "Not running (no session recorded) in /typo", which is true and useless.
  if (!fs.existsSync(project)) {
    throw new CliError(`No such directory: ${project}`, 2, 'Check the path passed to --project.');
  }
  if (!fs.statSync(project).isDirectory()) {
    throw new CliError(`--project must be a directory, but ${project} is a file.`, 2);
  }
  return { project, json: options['json'], quiet: options['quiet'] };
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
  .option('--port <port>', 'the bridge port to check for an orphaned client', START_DEFAULTS.port)
  .action(async (options) => runStop(globals(), options));

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
  .option('--diff <image.png>', 'assert this capture differs from an earlier one; exit 1 if it does not')
  .option('--min-diff <pct>', 'percentage of pixels that must differ for --diff to pass', '0.1')
  .option('--pixel-threshold <0-1>', 'per-pixel colour tolerance passed to pixelmatch', '0.1')
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
  .description('wait for ticks to pass, or for the game to reach a state')
  .option('--ticks <n>', 'wait this many client ticks')
  .option('--screen <name>', 'wait until this screen is open (simple or fully-qualified class name)')
  .option('--expr <groovy>', 'wait until this expression is true')
  .option('--chunk <x,y,z>', 'wait until the chunk containing this block is loaded')
  .option('--in-world', 'wait until a world is joined', false)
  .option('--timeout <ms>', 'give up after this many milliseconds', '10000')
  .action(async (options) => runWaitFor(globals(), options));

program
  .command('snapshot')
  .description('print the widget tree of the open screen as an outline')
  .option('--include-hidden', 'also list invisible widgets and pure decorations', false)
  .option('--max-depth <n>', 'stop descending past this depth')
  .option('--include-empty', 'keep the empty container slots in --json output', false)
  .action(async (options) => runSnapshot(globals(), options));

program
  .command('find <text>')
  .description('find widgets by label, type or path, and print where to click them')
  .option('--type <type>', 'only widgets whose class name contains this')
  .action(async (text, options) => runFind(globals(), text, options));

program
  .command('click')
  .description('click a point or a widget')
  .option('--at <x,y>', 'click this point')
  .option('--widget <text-or-path>', 'click the centre of the matching widget')
  .option('--button <n>', '0 left, 1 right, 2 middle', '0')
  .option('--space <space>', 'coordinate space for --at: gui or pixel', 'gui')
  .option('--shift', 'shift-click the slot under --at, moving the stack to the other inventory', false)
  .action(async (options) => runClick(globals(), options));

program
  .command('slot-click [slot]')
  .description('click a container slot with a named operation; quick_move is shift-click')
  .option('--at <x,y>', 'find the slot under this point instead of giving its index')
  .option('--type <type>', 'pickup, quick_move, swap, clone, throw, quick_craft or pickup_all', 'pickup')
  .option('--button <n>', '0 left, 1 right, 2 middle', '0')
  .action(async (slot, options) => runSlotClick(globals(), slot, options));

program
  .command('type <text>')
  .description('type text into the focused widget')
  .action(async (text) => runType(globals(), text));

program
  .command('set-text <widget> <value>')
  .description('replace a text field\'s contents: focus it, clear it, type the new value')
  .option('--commit <key>', 'key to press afterwards: enter, tab or none', 'none')
  .action(async (widget, value, options) => runSetText(globals(), widget, value, options));

program
  .command('key <key>')
  .description("press a key, e.g. 'E', 'ESCAPE' or 'GLFW_KEY_F3'")
  .option('--action <action>', 'tap, press or release', 'tap')
  .option('--modifiers <bits>', 'GLFW modifier bits: 1 shift, 2 ctrl, 4 alt')
  .action(async (key, options) => runKey(globals(), key, options));

program
  .command('hold-key <key>')
  .description('hold a bound key down for a number of ticks, for movement')
  .requiredOption('--ticks <n>', 'how many client ticks to hold it')
  .action(async (key, options) => runHoldKey(globals(), key, options));

program
  .command('mouse-move <at>')
  .description("move the mouse to 'x,y'")
  .option('--space <space>', 'gui or pixel', 'gui')
  .action(async (at, options) => runMouseMove(globals(), at, options));

program
  .command('scroll')
  .description('scroll at a point')
  .requiredOption('--at <x,y>', 'where to scroll')
  .requiredOption('--dy <amount>', 'vertical scroll amount')
  .option('--dx <amount>', 'horizontal scroll amount', '0')
  .option('--space <space>', 'gui or pixel', 'gui')
  .action(async (options) => runScroll(globals(), options));

program
  .command('drag')
  .description('press, move and release, for sliders and item dragging')
  .requiredOption('--from <x,y>', 'where the drag starts')
  .requiredOption('--to <x,y>', 'where it ends')
  .option('--button <n>', '0 left, 1 right', '0')
  .option('--steps <n>', 'how many intermediate move events to send', '8')
  .option('--space <space>', 'gui or pixel', 'gui')
  .action(async (options) => runDrag(globals(), options));

program
  .command('tooltip')
  .description('read the tooltip shown at a point or over a widget')
  .option('--at <x,y>', 'where to hover')
  .option('--widget <text-or-path>', 'hover the matching widget')
  .action(async (options) => runTooltip(globals(), options));

program
  .command('use-item')
  .description("right-click with the held item, aimed at nothing -- how most item GUIs open")
  .option('--hand <hand>', 'auto (as a player), main or off', 'auto')
  .option('--wait-screen', 'fail if no screen opened', false)
  .action(async (options) => runUseItem(globals(), options));

program
  .command('open-gui [x] [y] [z]')
  .description("right-click a block to open its GUI, or the held item with no coordinates")
  .option('--no-approach', 'do not teleport the player within reach first')
  .option('--face <face>', 'which side to aim at: down, up, north, south, east, west')
  .option('--at <x,y,z>', 'aim at this world point on the block, instead of a face centre')
  .action(async (x, y, z, options) => runOpenGui(globals(), x, y, z, options));

program
  .command('use <x> <y> <z>')
  .description('right-click a block with the held item, for placing and tools')
  .option('--no-approach', 'do not teleport the player within reach first')
  .option('--face <face>', 'which side to aim at: down, up, north, south, east, west')
  .option('--at <x,y,z>', 'aim at this world point on the block, instead of a face centre')
  .option('--sneak', 'hold sneak, which some blocks read to pick a different interaction', false)
  .option('--hand <hand>', "'main' or 'off'", 'main')
  .action(async (x, y, z, options) => runUse(globals(), x, y, z, options));

program
  .command('close-screen')
  .description('close the open screen')
  .action(async () => runCloseScreen(globals()));

program
  .command('inspect-gui <x> <y> <z>')
  .description('open a block GUI, print its outline, and write a screenshot — the usual starting point')
  .option('--no-approach', 'do not teleport the player within reach first')
  .option('--face <face>', 'which side to aim at: down, up, north, south, east, west')
  .option('--at <x,y,z>', 'aim at this world point on the block, instead of a face centre')
  .option('--name <name>', 'screenshot file name')
  .action(async (x, y, z, options) => runInspectGui(globals(), x, y, z, options));

program
  .command('world-reset')
  .description('delete and recreate the test world: creative superflat, no daylight cycle, no mobs')
  .option('--name <name>', 'world folder name')
  .option('--template <name>', 'copy clientdevbridge/templates/<name> instead of generating one')
  .option('--setup <command>', 'run this command once the world is ready')
  .action(async (options) => runWorldReset(globals(), options));

program
  .command('world-load <name>')
  .description('load an existing singleplayer world')
  .action(async (name) => runWorldLoad(globals(), name));

program
  .command('world-leave')
  .description('leave the current world')
  .action(async () => runWorldLeave(globals()));

program
  .command('world-list')
  .description('list the singleplayer worlds in the run directory')
  .action(async () => runWorldList(globals()));

program
  .command('command <command>')
  .description('run a Minecraft command on the integrated server and print its output')
  .action(async (command) => runCommand(globals(), command));

program
  .command('block <x> <y> <z>')
  .description('describe the block at a position')
  .option('--nbt', 'include the block entity NBT the client knows about', false)
  .action(async (x, y, z, options) => runBlock(globals(), x, y, z, options));

program
  .command('break <x> <y> <z>')
  .description('mine a block by holding attack until it gives way, and report what dropped')
  .option('--no-approach', 'do not teleport the player within reach first')
  .option('--face <face>', 'which side to aim at: down, up, north, south, east, west')
  .option('--at <x,y,z>', 'aim at this world point on the block, instead of a face centre')
  .option('--timeout-ticks <n>', 'give up after this many ticks (default 300)')
  .action(async (x, y, z, options) => runBreak(globals(), x, y, z, options));

program
  .command('walk-to <x> <z>')
  .description('walk to a horizontal position instead of teleporting to it')
  .option('--within <blocks>', 'how close counts as arrived', '0.6')
  .option('--timeout-ticks <n>', 'give up after this many ticks (default 300)')
  .action(async (x, z, options) => runWalkTo(globals(), x, z, options));

program
  .command('setblock <x> <y> <z> <block>')
  .description('place a block')
  .action(async (x, y, z, block) => runSetblock(globals(), x, y, z, block));

program
  .command('give <item> [count]')
  .description('give the player an item')
  .action(async (item, count) => runGive(globals(), item, count ?? '1'));

program
  .command('teleport <x> <y> <z>')
  .description('teleport the player')
  .option('--yaw <degrees>', 'facing yaw')
  .option('--pitch <degrees>', 'facing pitch')
  .action(async (x, y, z, options) => runTeleport(globals(), x, y, z, options));

program
  .command('look')
  .description('point the camera')
  .option('--at <x,y,z>', 'look at this block position')
  .option('--yaw <degrees>', 'set yaw')
  .option('--pitch <degrees>', 'set pitch')
  .action(async (options) => runLook(globals(), options));

program
  .command('registry <kind> [namespace]')
  .description('list what the loaded mods registered: blocks, items or namespaces')
  .option('--filter <text>', 'only names containing this')
  .option('--limit <n>', 'stop after this many names', '100')
  .action(async (kind, namespace, options) => runRegistry(globals(), kind, namespace, options));

program
  .command('inventory')
  .description("list the player's inventory")
  .option('--include-empty', 'keep the empty slots in --json output', false)
  .action(async (options) => runInventory(globals(), options));

program
  .command('compare <name>')
  .description('compare a screenshot against a committed golden image')
  .option('--region <x,y,w,h>', 'compare only this rectangle; applied to the golden too, so it needs no re-record')
  .option('--space <space>', 'coordinate space for --region: gui or pixel', 'gui')
  .option('--threshold <pct>', 'percentage of differing pixels still counted as a match', '0.1')
  .option('--pixel-threshold <0-1>', 'per-pixel colour tolerance passed to pixelmatch', '0.1')
  .option('--after-ticks <n>', 'wait this many ticks before capturing')
  .option('--renderer <name>', 'golden set to use, instead of detecting it from GL_RENDERER')
  .option('--update', 'write the current screenshot as the golden image instead of comparing', false)
  .action(async (name, options) => runCompare(globals(), name, options));

program
  .command('resize')
  .description('set the window size and GUI scale, for reproducible screenshots')
  .requiredOption('--width <px>', 'window width (required)')
  .requiredOption('--height <px>', 'window height (required)')
  .option('--gui-scale <n>', 'fixed GUI scale, or 0 for automatic; --width and --height are still required')
  .action(async (options) => runResize(globals(), options));

program
  .command('eval <code>')
  .description('evaluate a Groovy expression with mc, player, level, screen and server bound')
  .action(async (code) => runEval(globals(), code));

program
  .command('hotswap')
  .description('recompile the project and redefine the changed classes in the running client')
  .option('--no-compile', 'skip the Gradle compile and swap whatever is already built')
  .option('--baseline', 'record the current classes as the baseline without swapping', false)
  .option('--restart-if-needed', 'restart the client when a change cannot be swapped in place', false)
  .action(async (options) => runHotswap(globals(), options));

program
  .command('batch <file>')
  .description("run many commands over one connection; '-' reads them from stdin")
  .option('--continue-on-error', 'run every line even after one fails', false)
  .option('--json', 'print one JSON result object per command instead of their own output', false)
  .action(async (file, options) => {
    process.exitCode = await runBatch(
      globals(),
      file,
      { continueOnError: options['continueOnError'], json: options['json'], quiet: globals().quiet },
      (tokens) => program.parseAsync(hideNegativeNumbers([...tokens]), { from: 'user' }).then(() => undefined),
    );
  });

program
  .command('doctor')
  .description('check that this machine can build and launch a dev client')
  .option('--loader <loader>', 'check for this loader specifically: fabric or neoforge')
  .option('--no-network', 'skip the network reachability probes')
  .action(async (options) => {
    const code = await runDoctor(globals(), options);
    process.exitCode = code;
  });

/**
 * Piping into `head` or `grep -q` closes stdout while the CLI is still writing, and Node turns
 * that into a fatal EPIPE. Since piping is exactly how an agent reads this output, a broken pipe
 * has to mean "the reader has what it needs", not a crash.
 */
function ignoreBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        process.exit(process.exitCode ?? EXIT_OK);
      }
      throw error;
    });
  }
}

/**
 * Marker that hides a negative number from commander's option parser.
 *
 * Minecraft coordinates are routinely negative, and `teleport -10 5 -10` was rejected with
 * "unknown option '-10'". `--` is not a usable answer: it has to come before every operand, so it
 * would swallow the command's own flags too, and no reasonable caller thinks to write it. Nothing
 * in this CLI takes a numeric option name, so a token that looks like a negative number is one.
 */
const NEGATIVE_NUMBER_MARKER = '\u0000';

function hideNegativeNumbers(argv: readonly string[]): string[] {
  return argv.map((arg) => (/^-\d+(\.\d+)?$/.test(arg) ? `${NEGATIVE_NUMBER_MARKER}${arg}` : arg));
}

function reveal(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(NEGATIVE_NUMBER_MARKER)) {
    return value.slice(NEGATIVE_NUMBER_MARKER.length);
  }
  if (Array.isArray(value)) {
    return value.map(reveal);
  }
  return value;
}

// Undone in one place, after commander has finished parsing and before any command sees its
// arguments, so no individual command has to know this happened.
program.hook('preAction', (_parent, command) => {
  const withArgs = command as unknown as { processedArgs: unknown[] };
  withArgs.processedArgs = withArgs.processedArgs.map(reveal);
  const options = command.opts() as Record<string, unknown>;
  for (const [key, value] of Object.entries(options)) {
    options[key] = reveal(value);
  }
});

async function main(): Promise<void> {
  ignoreBrokenPipe();
  try {
    await program.parseAsync(hideNegativeNumbers(process.argv));
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
