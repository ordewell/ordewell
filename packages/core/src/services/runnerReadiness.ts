import type { RunnerManifest } from '../plugins/types';
import { BUILTIN_MANIFESTS } from '../plugins/builtin';
import type { RunnerInstallation, RunnerUsability } from './RunnerInstallation';
import type { ModelResolver } from './ModelResolver';
import type { UnlistedReason } from './ModelDiscovery';
import type { RunnerSignIn } from './signInHint';

/**
 * One runner's readiness as every surface reads it (ADR-0052), from the two
 * facts the host already holds: its usability with the recorded sign-in
 * verdict, and why its discovery listed nothing. Only `blocked` is a blocker:
 * the same recorded verdict refuses a planner turn before it is sent
 * (`plannerNotReadyFor`) and keeps the agent out of what a planner may assign
 * (`SessionCatalog.withheld`), so a picker that shows it agrees with both. A
 * blocked agent stays listed and choosable, with its way in.
 *
 * - `unusable`: not installed, too old, or cannot be started; not a sign-in matter.
 * - `blocked`: the agent refused as signed out (`signed-out`), or its
 *   credential hook found no key to start it with (`no-credential`).
 * - `pending`: its discovery is still being asked.
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
  if (unlisted === 'no-answer') return { kind: 'discovery-failed' };
  if (unlisted === 'no-choice') return { kind: 'agent-default' };
  return auth?.state === 'signed-in' ? { kind: 'ready' } : { kind: 'sign-in-unknown' };
}

export interface RunnerSignInCheck {
  installation: Pick<RunnerInstallation, 'refresh' | 'runnerUsability'>;
  /** The resolver for the same workspace, whose ACP handshake checks an agent with no status command. */
  resolver?: Pick<ModelResolver, 'rediscoverRunner'>;
  manifests?: { getManifest(runner: string): RunnerManifest | undefined };
}

const BUILTINS = { getManifest: (runner: string) => BUILTIN_MANIFESTS.find((m) => m.name === runner) };

/** The check a user's recheck runs, which forgets the record first. */
export type RunnerRecheck = RunnerSignInCheck & { installation: Pick<RunnerInstallation, 'refresh' | 'recheck' | 'runnerUsability'> };

/**
 * An agent with no status command whose only cheap sign-in check is opening an
 * ACP session, as discovery does: no poll can confirm its login, so a login
 * flow rechecks it once the user is done.
 */
export function checksSignInByHandshake(manifest: RunnerManifest | undefined): boolean {
  return !!manifest && !manifest.auth?.statusArgs && manifest.modelDiscovery.method === 'acp';
}

async function askAgain(runner: string, check: RunnerSignInCheck): Promise<RunnerUsability> {
  if (check.resolver && checksSignInByHandshake((check.manifests ?? BUILTINS).getManifest(runner))) {
    await check.resolver.rediscoverRunner(runner).catch(() => undefined);
  }
  return check.installation.runnerUsability(runner);
}

/**
 * Before a send to a planner recorded signed out: ask for current evidence,
 * keeping the blocker unless it arrives. A status command answers for
 * itself; a status-less ACP agent is asked by its own handshake, which a
 * refusal answers at once, so a sign-in done in another terminal is seen
 * without a recheck. An ask that gets no answer leaves the agent refused.
 */
export async function verifyRunnerSignIn(runner: string, check: RunnerSignInCheck): Promise<RunnerUsability> {
  check.installation.refresh();
  return askAgain(runner, check);
}

/**
 * The user's explicit recovery for one runner in one workspace: a login that
 * finished, or a recheck asked for. What was recorded is forgotten, then the
 * runner is asked as {@link verifyRunnerSignIn} asks it. Where nothing can
 * say, it reads `unknown`, never signed in on a terminal's exit alone, so the
 * user can send again and a new refusal records the blocker again. Nothing
 * is resent on the user's behalf.
 */
export async function recheckRunnerSignIn(runner: string, check: RunnerRecheck): Promise<RunnerUsability> {
  await check.installation.recheck(runner);
  return askAgain(runner, check);
}
