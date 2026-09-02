import * as fs from 'node:fs';
import { z } from 'zod';
import { SessionError } from './errors.js';
import { type BridgePaths, resolvePaths } from './paths.js';

export const sessionSchema = z.object({
  version: z.literal(1),
  port: z.number().int().positive(),
  pid: z.number().int().positive(),
  pgid: z.number().int(),
  loader: z.enum(['fabric', 'neoforge']),
  mcVersion: z.string(),
  bridgeVersion: z.string(),
  projectDir: z.string(),
  gradleTask: z.string(),
  startedAt: z.string(),
  world: z.string().nullable(),
  headed: z.boolean(),
  display: z.string().nullable(),
  jdwpPort: z.number().int().positive().nullable(),
  /**
   * Xvfb servers this launch started. `stop` kills them explicitly: killing the process group
   * does not reliably take them with it, and a leaked one is not harmless -- a stale server on a
   * display a later run reuses makes the next client die with an X GLX BadAccess before it
   * renders anything. Optional so a session file written by an older CLI still parses.
   */
  xvfbPids: z.array(z.number().int().positive()).optional(),
  /**
   * The launch options a restart has to reproduce.
   *
   * Without these, restarting silently resets the window to the default size and turns eval back
   * on, and a screenshot taken after the restart no longer lines up with one taken before it.
   * Optional so a session file written by an older CLI still parses.
   */
  launch: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      evalEnabled: z.boolean(),
      // Optional so a session.json written by an older CLI still parses: a client running under
      // the previous version must not become unreadable the moment this one is installed.
      toasts: z.boolean().optional(),
      pinOptions: z.boolean(),
      gradleArgs: z.array(z.string()),
      timeoutMs: z.number().int().positive(),
    })
    .optional(),
});

export type Session = z.infer<typeof sessionSchema>;

export interface SessionStatus {
  readonly paths: BridgePaths;
  readonly session: Session | null;
  /** True when session.json exists but the process it names is gone (a reclaimed VM, a crash, a reboot). */
  readonly stale: boolean;
}

export function readSession(projectDir: string): SessionStatus {
  const paths = resolvePaths(projectDir);
  if (!fs.existsSync(paths.sessionFile)) {
    return { paths, session: null, stale: false };
  }

  let parsed: Session;
  try {
    parsed = sessionSchema.parse(JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8')));
  } catch {
    // A truncated or older session file is treated exactly like a dead one, so that a cold VM
    // never leaves the CLI stuck on a file it cannot read.
    return { paths, session: null, stale: true };
  }

  return { paths, session: parsed, stale: !isProcessAlive(parsed.pid) };
}

export function writeSession(paths: BridgePaths, session: Session): void {
  fs.writeFileSync(paths.sessionFile, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

export function clearSession(paths: BridgePaths): void {
  if (fs.existsSync(paths.sessionFile)) {
    fs.rmSync(paths.sessionFile);
  }
}

/**
 * Returns the session for commands that need a running client, with a message that says what to do
 * rather than just what went wrong.
 */
export function requireRunningSession(projectDir: string): { session: Session; paths: BridgePaths } {
  const status = readSession(projectDir);
  if (status.session === null) {
    if (status.stale) {
      throw new SessionError(
        `The session file at ${status.paths.sessionFile} is unreadable, so no client is being tracked.`,
        "Run 'clientdevbridge start' to launch a fresh client.",
      );
    }
    throw new SessionError(
      `No ClientDevBridge session in ${status.paths.projectDir}.`,
      "Run 'clientdevbridge start' first (add --project <dir> if the mod project is elsewhere).",
    );
  }
  if (status.stale) {
    throw new SessionError(
      `The recorded client (pid ${status.session.pid}) is no longer running.`,
      "Run 'clientdevbridge start' to launch a new one; 'clientdevbridge logs --gradle' shows why the old one exited.",
    );
  }
  return { session: status.session, paths: status.paths };
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
