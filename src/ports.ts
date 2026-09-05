import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isProcessAlive } from './session.js';

/**
 * Which launch owns which bridge port, while the client it is for is still booting.
 *
 * Two launches on one machine cannot share a port, and the port is the only thing they do share:
 * everything else a session writes lives under its own project's `.clientdevbridge/`. Checking
 * whether anything is listening is not enough to keep them apart, because a client takes a minute
 * or two to get as far as binding, and a second launch started anywhere in that window sees a free
 * port and takes the same one. Both then reach a client that cannot bind, several minutes later,
 * with nothing to say why.
 *
 * So a launch writes down the port it is about to use, and a concurrent one skips a port that is
 * spoken for. The file lives in the temporary directory rather than in either project, because it
 * belongs to the machine and not to a checkout, and because a reboot should forget all of them.
 *
 * The claim covers only the gap between choosing a port and the client binding it: after that the
 * client itself is the evidence, which is why the claim is released when `start` returns and
 * nothing has to remember it later. A claim whose process is gone is ignored and taken over --
 * that is a launch that was killed mid-boot, and its port is free again.
 */
interface Claim {
  readonly pid: number;
  readonly projectDir: string;
  readonly at: string;
}

export interface PortClaim {
  readonly port: number;
  /** Gives the port back. Safe to call twice, and never removes a claim someone else has taken. */
  release(): void;
}

export function claimDirectory(): string {
  return path.join(os.tmpdir(), 'clientdevbridge', 'ports');
}

function claimFile(port: number): string {
  return path.join(claimDirectory(), `${port}.json`);
}

function readClaim(file: string): Claim | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const claim = parsed as Claim;
    return typeof claim?.pid === 'number' && Number.isInteger(claim.pid) ? claim : null;
  } catch {
    // Missing, half-written, or from a future version: all three mean "nothing to respect here".
    return null;
  }
}

/** The launch currently holding this port, or null when it is nobody's. */
export function claimOn(port: number): { pid: number; projectDir: string } | null {
  const claim = readClaim(claimFile(port));
  return claim !== null && isProcessAlive(claim.pid)
    ? { pid: claim.pid, projectDir: claim.projectDir }
    : null;
}

/**
 * Takes this port for this process, or returns null when a live launch already has it.
 *
 * The claim is made by creating the file exclusively, so two launches racing for the same port
 * cannot both win: the loser gets EEXIST and moves on to the next one.
 */
export function claimPort(port: number, projectDir: string): PortClaim | null {
  const file = claimFile(port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine: Claim = { pid: process.pid, projectDir, at: new Date().toISOString() };

  // Twice at most: once for the file not being there, once for having just cleared a dead claim.
  // A third attempt would mean someone else claimed it in between, which is their port now.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(mine, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      const drop = (): void => {
        // Only ours. A claim taken over by another launch after this process was declared dead --
        // which happens to a `start` suspended long enough to look gone -- belongs to them, and
        // deleting it would hand a port that is in use to a third launch.
        const held = readClaim(file);
        if (held !== null && held.pid === process.pid) {
          try {
            fs.rmSync(file);
          } catch {
            // Already gone, which is all the release wanted.
          }
        }
      };
      // Also on the way out, so a launch that fails anywhere between here and the client binding
      // the port does not leave the next one stepping around a port nobody holds. A claim whose
      // process was killed outright is taken over on sight, so this is tidiness rather than
      // correctness -- but an unexplained file in a temporary directory is its own small puzzle.
      process.on('exit', drop);
      return {
        port,
        release: () => {
          process.removeListener('exit', drop);
          drop();
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (claimOn(port) !== null) {
        return null;
      }
      try {
        fs.rmSync(file);
      } catch {
        // Someone else cleared the same dead claim first; the next attempt decides who gets it.
      }
    }
  }
  return null;
}
