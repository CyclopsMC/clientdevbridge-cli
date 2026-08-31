/**
 * Exit codes are part of the CLI's contract with the agent driving it:
 * 0 success, 1 a protocol-level failure, 2 a session or connection failure,
 * 3 nothing is wrong yet but the thing asked for is not ready.
 *
 * Three exists because a first `start` on a machine with no toolchain cache takes fifteen to
 * twenty minutes, and reporting that as a session failure told callers to go looking for a break
 * that had not happened. "Not ready" and "broken" need different reactions -- wait, versus stop --
 * so they need different codes.
 */
export const EXIT_OK = 0;
export const EXIT_PROTOCOL = 1;
export const EXIT_SESSION = 2;
export const EXIT_NOT_READY = 3;


/** A failure that should be reported with a specific exit code, without a stack trace. */
export class CliError extends Error {
  public readonly exitCode: number;
  public readonly hint: string | undefined;

  public constructor(message: string, exitCode: number = EXIT_SESSION, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** The mod answered with a JSON-RPC error object. */
export class ProtocolError extends CliError {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(message, EXIT_PROTOCOL);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }
}

/** Nothing is listening, or the session is stale. Always carries the same actionable hint. */
export class SessionError extends CliError {
  public constructor(message: string, hint = "Run 'clientdevbridge status' to see the session state, or 'clientdevbridge logs' for the game log.") {
    super(message, EXIT_SESSION, hint);
    this.name = 'SessionError';
  }
}

/**
 * The build is still running and healthy; the caller should wait rather than investigate.
 *
 * Separate from SessionError because the two need opposite reactions, and a caller that cannot
 * tell them apart has to treat every slow first build as a broken one.
 */
export class NotReadyError extends CliError {
  public constructor(message: string, hint: string) {
    super(message, EXIT_NOT_READY, hint);
    this.name = 'NotReadyError';
  }
}
