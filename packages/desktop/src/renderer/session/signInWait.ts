/**
 * How long a sign-in is given, and how often the agent's own status command is
 * asked again (ADR-0052). One rule for the chat's login terminal and the
 * launcher's, so neither claims a sign-in the agent did not confirm.
 */

export const SIGN_IN_POLL_MS = 2_000;
/** Long enough for a browser OAuth or a device code, short enough to end a forgotten one. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export const SIGN_IN_CLOSED = 'The terminal closed before sign-in finished.';
export const SIGN_IN_TIMEOUT = 'Sign-in did not finish in time.';

export interface SignInOutcome {
  ok: boolean;
  message?: string;
}

export interface SignInWaitDeps {
  /** Resolves when the login terminal's process exits or its tab closes. */
  ended: Promise<void>;
  /** The agent's own status command: the only thing that may say it worked. */
  signedIn(): Promise<boolean>;
  pollMs?: number;
  timeoutMs?: number;
  /** Awaited between polls; injectable so a test never waits real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the timeout is measured against; injectable with `sleep`. */
  now?: () => number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the agent until it reports itself signed in, its terminal ends, or the
 * budget runs out. A failed probe is no answer: the next poll asks again.
 */
export async function waitForSignIn(deps: SignInWaitDeps): Promise<SignInOutcome> {
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? SIGN_IN_POLL_MS;
  const deadline = now() + (deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  while (now() < deadline) {
    const next = await Promise.race([
      sleep(pollMs).then(() => 'tick' as const),
      deps.ended.then(() => 'ended' as const),
    ]);
    if (next === 'ended') return { ok: false, message: SIGN_IN_CLOSED };
    let signedIn = false;
    try {
      signedIn = await deps.signedIn();
    } catch {
      signedIn = false;
    }
    if (signedIn) return { ok: true };
  }
  return { ok: false, message: SIGN_IN_TIMEOUT };
}
