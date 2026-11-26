import { describeLoginStillBlocked, TERMINAL_UI_SIGN_IN, type RunnerSignIn, type SignInSyntax } from '@ordewell/core/plan-utils';

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

/** A login that exited cleanly, for an agent that still cannot say: never taken as signed in (ADR-0052). */
export const signInUnconfirmed = (label: string): string =>
  `The login finished, but ${label} cannot say whether it is signed in. Send again to try it.`;
/** A recheck still signed out: for an agent that only lacks a key, what Ordewell lacks, since the agent was never asked. */
export const signInStillOut = (label: string, signIn?: RunnerSignIn, syntax: SignInSyntax = TERMINAL_UI_SIGN_IN): string => describeLoginStillBlocked(label, signIn, syntax);

type AuthState = 'signed-in' | 'signed-out' | 'unknown';

export interface SignInWaitDeps {
  /** Resolves with the login's exit code when its process exits, or with none when its tab closes first. */
  ended: Promise<number | void>;
  /** The agent's own status command: the only thing that may say it worked. */
  signedIn(): Promise<boolean>;
  pollMs?: number;
  timeoutMs?: number;
  /** Awaited between polls; injectable so a test never waits real seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the timeout is measured against; injectable with `sleep`. */
  now?: () => number;
  /**
   * Asked once when the login exits 0: the daemon's recheck of the agent
   * (`runners.list?recheck=`), which forgets the refusal it recorded and asks
   * again. An agent with no status command never reads signed in on its own,
   * so without this a login that worked ended as a closed terminal (#46 F7).
   * A failed or cancelled login is never rechecked, so its blocker stays.
   */
  recheck?(): Promise<AuthState | { state: AuthState; signIn?: RunnerSignIn } | undefined>;
  /** The agent as the recheck's outcome names it. */
  label?: string;
  /** How that outcome names the surface's ways in: the chat's /login unless the surface has buttons instead. */
  syntax?: SignInSyntax;
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
    if (next === 'ended') return afterExit(deps, await deps.ended);
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

async function afterExit(deps: SignInWaitDeps, code: number | void): Promise<SignInOutcome> {
  if (code !== 0 || !deps.recheck) return { ok: false, message: SIGN_IN_CLOSED };
  const answer = await deps.recheck().catch(() => undefined);
  // The state alone, or the verdict whose ways in word what still blocks it.
  const verdict = typeof answer === 'string' ? { state: answer } : answer;
  const state = verdict?.state;
  if (state === 'signed-in') return { ok: true };
  const label = deps.label ?? 'The agent';
  if (state === 'signed-out') return { ok: false, message: signInStillOut(label, verdict?.signIn, deps.syntax) };
  if (state === 'unknown') return { ok: false, message: signInUnconfirmed(label) };
  return { ok: false, message: SIGN_IN_CLOSED };
}
