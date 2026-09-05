import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimDirectory, claimOn, claimPort, type PortClaim } from '../src/ports.js';
import { processGroupOf, xvfbPidsOfGroup } from '../src/xvfb.js';

// Ports well outside the range a real launch scans, so a test can never collide with a client
// someone is actually running on this machine.
let next = 41000;
const takePort = (): number => (next += 1);

const held: PortClaim[] = [];
const claim = (port: number, project = '/tmp/project'): PortClaim | null => {
  const result = claimPort(port, project);
  if (result !== null) {
    held.push(result);
  }
  return result;
};

afterEach(() => {
  for (const claimed of held.splice(0)) {
    claimed.release();
  }
});

/** Writes a claim by hand, as another process would have left it. */
function writeForeignClaim(port: number, pid: number, projectDir: string): string {
  const file = path.join(claimDirectory(), `${port}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, projectDir, at: new Date().toISOString() }), 'utf8');
  return file;
}

describe('holding a port while a client boots', () => {
  it('gives the port to the first claim and refuses the second', () => {
    const port = takePort();
    expect(claim(port)).not.toBeNull();
    expect(claimPort(port, '/tmp/other')).toBeNull();
  });

  it('frees the port again on release', () => {
    const port = takePort();
    const first = claim(port);
    expect(first).not.toBeNull();
    first?.release();
    expect(claimOn(port)).toBeNull();
    expect(claim(port, '/tmp/other')).not.toBeNull();
  });

  // The case the claim exists for: a client takes a minute or two to bind, so a port that is
  // demonstrably not listening can still be spoken for.
  it('reports a live claim on a port nothing is listening on', () => {
    const port = takePort();
    claim(port, '/tmp/first');
    expect(claimOn(port)).toEqual({ pid: process.pid, projectDir: '/tmp/first' });
  });

  // A launch killed between choosing a port and starting the client would otherwise block that
  // port until the machine rebooted.
  it('takes over a claim whose process is gone', () => {
    const port = takePort();
    // pid 2^22 is above every default pid_max, so nothing can be running under it.
    writeForeignClaim(port, 4_194_304, '/tmp/dead');
    expect(claimOn(port)).toBeNull();
    expect(claim(port)).not.toBeNull();
    expect(claimOn(port)?.pid).toBe(process.pid);
  });

  it('leaves a claim alone when it belongs to a process that is still alive', () => {
    const port = takePort();
    // pid 1 stands in for another live launch: it always exists, and signalling it is refused
    // rather than failing, which is exactly the case the liveness check has to read as "alive".
    const file = writeForeignClaim(port, 1, '/tmp/theirs');
    try {
      expect(claimPort(port, '/tmp/mine')).toBeNull();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('ignores an unreadable claim rather than treating the port as taken', () => {
    const port = takePort();
    const file = path.join(claimDirectory(), `${port}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf8');
    expect(claimOn(port)).toBeNull();
    expect(claim(port)).not.toBeNull();
  });

  // Releasing has to be safe after another launch has taken the port over, or a start that was
  // suspended long enough to look dead would hand a port that is in use to a third launch.
  it('does not release a claim another process has taken over', () => {
    const port = takePort();
    const mine = claimPort(port, '/tmp/mine');
    expect(mine).not.toBeNull();
    const file = writeForeignClaim(port, 1, '/tmp/theirs');
    mine?.release();
    expect(fs.existsSync(file)).toBe(true);
    expect(claimOn(port)?.projectDir).toBe('/tmp/theirs');
    fs.rmSync(file, { force: true });
  });
});

describe('attributing X servers to the launch that started them', () => {
  // The point of the narrowing: a concurrent launch's server appears inside our window too, and
  // only the process group tells the two apart. pid 1 stands in for the other launch's server --
  // it is live, and it is certainly not in this process's group.
  it('keeps only the servers in this launch group', () => {
    const ourGroup = processGroupOf(process.pid);
    expect(ourGroup).not.toBeNull();
    expect(xvfbPidsOfGroup([process.pid, 1], ourGroup as number)).toEqual([process.pid]);
  });

  // Rather than none: a leaked Xvfb holds its display lock, and the next run that lands on that
  // display dies before it renders anything.
  it('falls back to every server that appeared when no group matches', () => {
    expect(xvfbPidsOfGroup([4_194_304], 1)).toEqual([4_194_304]);
  });

  it('claims nothing when nothing appeared', () => {
    expect(xvfbPidsOfGroup([], 1)).toEqual([]);
  });
});
