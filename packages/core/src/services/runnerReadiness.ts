import type { RunnerManifest } from '../plugins/types';
import { BUILTIN_MANIFESTS } from '../plugins/builtin';
import type { RunnerInstallation, RunnerUsability } from './RunnerInstallation';
import type { ModelResolver } from './ModelResolver';
import type { UnlistedReason } from './ModelDiscovery';
import { recordedRunnerAuth } from './runnerAuth';
import { runnerChoice, runnerChoiceRefusal, runnerEntryReadiness, runnerReadiness, RunnerNotReadyError } from './runnerChoice';

export * from './runnerChoice';

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

/** What {@link refuseBlockedPick} reads: the same check as a send, and that workspace's discovery answers. */
export interface RunnerPickCheck extends RunnerSignInCheck {
  workspace?: string;
  unlisted: () => Readonly<Record<string, UnlistedReason>>;
}

/**
 * Refuse a new pick of `runner` — a planner switched to it, it switched on, a
 * task moved onto it — when its readiness blocks one (ADR-0052). The picker's
 * list may be stale, so it is judged again here as the send gate judges a
 * planner: a recorded sign-out is asked again first, so a sign-in done since
 * lets the pick through. A choice already made is never the caller's to pass.
 */
export async function refuseBlockedPick(runner: string, label: string, check: RunnerPickCheck): Promise<void> {
  const usability = recordedRunnerAuth(runner, check.workspace)?.state === 'signed-out'
    ? await verifyRunnerSignIn(runner, check)
    : await check.installation.runnerUsability(runner);
  // A verdict with only a login command still names its way in, so the
  // refusal can offer that agent's Sign in.
  const readiness = runnerEntryReadiness({ id: runner, name: label, ...(usability.auth ? { auth: usability.auth } : {}), readiness: runnerReadiness(usability, check.unlisted()[runner]) });
  if (runnerChoice(readiness).group !== 'blocked') return;
  throw new RunnerNotReadyError(runner, readiness, runnerChoiceRefusal(label, readiness) ?? `${label} cannot be picked now.`);
}
