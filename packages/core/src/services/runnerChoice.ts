import type { RunnerUsability } from './RunnerInstallation';
import type { UnlistedReason } from './ModelDiscovery';
import { describeSignIn, signInOfVerdict, TERMINAL_UI_SIGN_IN, type RunnerSignIn, type SignInSyntax } from './signInHint';
import type { RunnerAuth } from './runnerAuth';

// The readiness-to-choice rule alone, with nothing Node-bound, so a webview's
// picker reads it from `plan-utils` as the hosts read it (ADR-0052).

/**
 * One runner's readiness as every surface reads it (ADR-0052), from the two
 * facts the host already holds: its usability with the recorded sign-in
 * verdict, and why its discovery listed nothing. `blocked` is the sign-in
 * blocker: the same recorded verdict refuses a planner turn before it is sent
 * (`plannerNotReadyFor`) and keeps the agent out of what a planner may assign
 * (`SessionCatalog.withheld`), so a picker that shows it agrees with both. A
 * blocked agent stays listed and choosable, with its way in.
 *
 * - `unusable`: not installed, too old, or cannot be started; not a sign-in matter.
 * - `blocked`: the agent refused as signed out (`signed-out`), or its
 *   credential hook found no key to start it with (`no-credential`).
 * - `pending`: its discovery is still being asked.
 * - `no-usable-model`: its discovery finished and listed no model, and it is
 *   no agent that runs on its own default: there is nothing to run it on.
 * - `discovery-failed`: the ask got no answer; nothing is known of the sign-in.
 * - `agent-default`: it answered with no model to choose, so a planner on it
 *   runs on the agent's own default model.
 * - `sign-in-unknown`: no evidence either way (no status command, not asked
 *   since a recheck); offered and never blocked.
 * - `ready`: signed in by evidence.
 */
export type RunnerReadiness =
  | { kind: 'unusable'; reason?: string }
  | { kind: 'blocked'; why: 'signed-out' | 'no-credential'; signIn?: RunnerSignIn }
  | { kind: 'no-usable-model' }
  | { kind: 'pending' }
  | { kind: 'discovery-failed' }
  | { kind: 'agent-default' }
  | { kind: 'sign-in-unknown' }
  | { kind: 'ready' };

export function runnerReadiness(usability: RunnerUsability, unlisted?: UnlistedReason): RunnerReadiness {
  if (!usability.usable) return { kind: 'unusable', ...(usability.reason ? { reason: usability.reason } : {}) };
  const auth = usability.auth;
  // Blocked only on the recorded verdict, never on discovery's words alone,
  // so the picker, the gate and the catalog cannot disagree.
  if (auth?.state === 'signed-out') {
    return { kind: 'blocked', why: unlisted === 'no-credential' ? 'no-credential' : 'signed-out', ...(auth.signIn ? { signIn: auth.signIn } : {}) };
  }
  if (unlisted === 'pending') return { kind: 'pending' };
  if (unlisted === 'no-models') return { kind: 'no-usable-model' };
  if (unlisted === 'no-answer') return { kind: 'discovery-failed' };
  if (unlisted === 'no-choice') return { kind: 'agent-default' };
  return auth?.state === 'signed-in' ? { kind: 'ready' } : { kind: 'sign-in-unknown' };
}

/** What a row's recovery control does, for a surface to bind: its own Log in, key entry or refresh. */
export type RunnerRecoveryKind = 'sign-in' | 'add-key' | 'refresh-models' | 'retry';

/**
 * A runner as a picker offers it (ADR-0052): one short status in words, the
 * recovery its row offers, and whether a new pick is refused. Colour is only
 * `tone`'s reinforcement of `text`, never the only signal.
 */
export interface RunnerChoice {
  status: Exclude<RunnerReadiness['kind'], 'blocked'> | 'signed-out' | 'no-credential';
  /** The canonical short status; absent on a ready row, and on an unusable one, whose reason says it. */
  text?: string;
  recovery?: { kind: RunnerRecoveryKind; label: string };
  /**
   * A new planner pick, runner switched on or task assigned to it is refused.
   * One already made is kept: a saved choice is never dropped for it.
   */
  blocksNewChoice: boolean;
  /** Choosable rows are listed first, then blocked ones, then unusable ones ({@link orderByChoice}). */
  group: 'choosable' | 'blocked' | 'unusable';
  tone: 'none' | 'muted' | 'warning' | 'error';
}

const CHOICES: Record<RunnerChoice['status'], Omit<RunnerChoice, 'status'>> = {
  ready: { blocksNewChoice: false, group: 'choosable', tone: 'none' },
  unusable: { blocksNewChoice: true, group: 'unusable', tone: 'muted' },
  'signed-out': { text: 'Signed out', recovery: { kind: 'sign-in', label: 'Sign in' }, blocksNewChoice: true, group: 'blocked', tone: 'error' },
  'no-credential': { text: 'API key needed', recovery: { kind: 'add-key', label: 'Add key' }, blocksNewChoice: true, group: 'blocked', tone: 'error' },
  'no-usable-model': { text: 'No usable model', recovery: { kind: 'refresh-models', label: 'Refresh models' }, blocksNewChoice: true, group: 'blocked', tone: 'error' },
  // Never a blocker: an ask that got no answer says nothing about the runner.
  'discovery-failed': { text: "Couldn't load models", recovery: { kind: 'retry', label: 'Retry' }, blocksNewChoice: false, group: 'choosable', tone: 'warning' },
  pending: { text: 'Checking models…', blocksNewChoice: false, group: 'choosable', tone: 'muted' },
  'sign-in-unknown': { text: 'Sign-in not checked', blocksNewChoice: false, group: 'choosable', tone: 'muted' },
  'agent-default': { text: 'Uses agent default', blocksNewChoice: false, group: 'choosable', tone: 'muted' },
};

/** The one readiness-to-choice rule every picker and host write reads. */
export function runnerChoice(readiness: RunnerReadiness): RunnerChoice {
  const status = readiness.kind === 'blocked' ? readiness.why : readiness.kind;
  return { status, ...CHOICES[status] };
}

/**
 * A runner row's choice. A row from a daemon that predates `readiness` is read
 * from its sign-in alone, which is all it can know.
 */
export function runnerEntryChoice(entry: RunnerReadinessFields): RunnerChoice {
  return runnerChoice(runnerEntryReadiness(entry));
}

/** The fields of a daemon runner row (`RunnerEntry`) readiness is read from. */
export interface RunnerReadinessFields { id?: string; name?: string; usable?: boolean; reason?: string; auth?: RunnerAuth; readiness?: RunnerReadiness }

/**
 * A runner row's readiness, from its sign-in alone where its daemon sent none.
 * A blocker carries its way in, from the row's login command where an older
 * verdict has no `signIn`.
 */
export function runnerEntryReadiness(entry: RunnerReadinessFields): RunnerReadiness {
  const readiness = entry.readiness ?? runnerReadiness({ usable: entry.usable !== false, ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.auth ? { auth: entry.auth } : {}) });
  if (readiness.kind !== 'blocked' || readiness.signIn || !entry.id) return readiness;
  const signIn = signInOfVerdict(entry.id, entry.name ?? entry.id, entry.auth);
  return signIn ? { ...readiness, signIn } : readiness;
}

const GROUP_RANK: Record<RunnerChoice['group'], number> = { choosable: 0, blocked: 1, unusable: 2 };

/** `rows` with the choosable first, then the blocked, then the unusable, each group in its given order. */
export function orderByChoice<T>(rows: readonly T[], choiceOf: (row: T) => RunnerChoice): T[] {
  return rows
    .map((row, at) => ({ row, at, rank: GROUP_RANK[choiceOf(row).group] }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ row }) => row);
}

/**
 * Why a host refuses a new pick of `label`'s runner, worded with its way back,
 * or null where nothing blocks one. The daemon words for the terminal.
 */
export function runnerChoiceRefusal(label: string, readiness: RunnerReadiness, syntax: SignInSyntax = TERMINAL_UI_SIGN_IN): string | null {
  if (readiness.kind === 'unusable') return readiness.reason ?? `${label} cannot be started here.`;
  if (readiness.kind === 'no-usable-model') return `${label} lists no model it can run. Run /refresh to load its models again, then pick it.`;
  if (readiness.kind !== 'blocked') return null;
  if (readiness.signIn) return `${describeSignIn(readiness.signIn, syntax)} Then pick it again.`;
  return readiness.why === 'no-credential'
    ? `${label} has no API key to start with. Add one, then pick it again.`
    : `${label} is not signed in. Sign in, then pick it again.`;
}

/**
 * A new pick refused at the host's write (ADR-0052): the picker's snapshot can
 * be stale, so the host reads the runner again before it writes.
 */
export class RunnerNotReadyError extends Error {
  constructor(readonly runner: string, readonly readiness: RunnerReadiness, message: string) {
    super(message);
    this.name = 'RunnerNotReadyError';
  }
}
