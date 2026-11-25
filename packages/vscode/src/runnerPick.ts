import {
  refuseBlockedPick, runnerReadiness, RunnerNotReadyError,
  type ModelResolver, type RunnerInstallation, type RunnerReadiness,
} from '@ordewell/core';
import type { ChatViewProvider } from './providers/ChatViewProvider';

/**
 * What this window reads an agent's readiness from (ADR-0052): its install
 * probe with the recorded sign-in, and its discovery's answers. The same facts
 * the daemon reads for the desktop app and the terminal, so a pick VS Code
 * allows is one they would allow too.
 */
export interface RunnerPickDeps {
  runnerInstallation: Pick<RunnerInstallation, 'refresh' | 'runnerUsability'>;
  modelResolver: Pick<ModelResolver, 'rediscoverRunner' | 'getRunnerUnlisted'>;
  workspaceRoot: () => string;
}

/** One runner's readiness as this window's pickers show it. */
export async function readinessOf(runner: string, deps: RunnerPickDeps): Promise<RunnerReadiness> {
  return runnerReadiness(await deps.runnerInstallation.runnerUsability(runner), deps.modelResolver.getRunnerUnlisted()[runner]);
}

/**
 * Refuse a new pick of `runner` — the planner switched to it, it switched on,
 * a task moved onto it — while its readiness blocks one. The webview's list
 * may be stale, so it is judged again here, as the daemon judges a pick.
 */
export function refuseBlockedRunner(runner: string, label: string, deps: RunnerPickDeps): Promise<void> {
  return refuseBlockedPick(runner, label, {
    installation: deps.runnerInstallation,
    resolver: deps.modelResolver,
    workspace: deps.workspaceRoot(),
    unlisted: () => deps.modelResolver.getRunnerUnlisted(),
  });
}

/**
 * Say a refused pick in the chat, with the refused agent's own Sign in where
 * it has one: the chat's error banner offers it as it does for any refusal
 * that names a signed-out agent. False for anything else, which the caller
 * reports as it always has.
 */
export function showPickRefusal(error: unknown, chat: Pick<ChatViewProvider, 'showError'>): boolean {
  if (!(error instanceof RunnerNotReadyError)) return false;
  const signIn = error.readiness.kind === 'blocked' ? error.readiness.signIn : undefined;
  chat.showError(error.message, undefined, signIn);
  return true;
}
