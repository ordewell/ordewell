import { hasFlag, positionals } from '../utils';
import { DaemonError, type ApiClient } from '../apiClient';
import { checkoutRule, handoffBaseLine, handoffBranchName, isRepoGroup, isolationViewOfPlan, mergeOutcome, mergeTarget, repairedLanded, repairedNotice, repoResultLines } from '@ordewell/core';
import { HANDOFF_ACTIONS } from '../tui/handoff';
import { adopted } from './conversation';
import { askYesNo, fail } from './shared';

const USAGE = 'Usage: ordewell handoff [review|merge|discard|cleanup] [--session-id <id>] [--workspace /path] [--yes] [--past-checks]';

/**
 * Land an isolated run's branch (ADR-0013) — the terminal counterpart of the
 * TUI's `/handoff`. Merge and discard are the steps that cannot be undone, so
 * they ask first; `--yes` is the explicit, scriptable way to have asked already.
 */
export async function handleHandoff(
  subArgs: string[],
  injectedApi?: ApiClient,
  confirm: (question: string) => Promise<boolean> = askYesNo,
): Promise<void> {
  const action = positionals(subArgs)[0]?.toLowerCase();

  if (action === undefined) {
    console.log(`${USAGE}\n`);
    for (const a of HANDOFF_ACTIONS) console.log(`  ${a.id.padEnd(8)} ${a.label}: ${a.hint}`);
    return;
  }
  if (!HANDOFF_ACTIONS.some((a) => a.id === action)) fail(`Unknown handoff action "${action}".`, USAGE);

  const { api, sessionId, plan } = await adopted(subArgs, injectedApi);
  const handoff = isolationViewOfPlan(plan)?.handoff;
  if (!handoff) fail('This session has no isolated run to hand off.');
  const branch = handoffBranchName(handoff);
  const group = isRepoGroup(handoff);
  if (group) for (const line of repoResultLines(handoff)) console.error(line);

  const asked = hasFlag(subArgs, '--yes');
  const confirmed = async (question: string): Promise<void> => {
    if (asked || (await confirm(question))) return;
    fail('Not confirmed: nothing was changed. Pass --yes to confirm without a prompt.');
  };

  // Wraps only the daemon calls, so a refusal the user caused (declining a
  // confirmation) is not reported as a failure of the action.
  const attempt = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      return fail(`Handoff ${action} failed: ${(err as Error).message}`);
    }
  };

  switch (action) {
    case 'review': {
      const diff = await attempt(() => api.reviewRunDiff(sessionId));
      console.log(diff.trim() === '' ? `Nothing differs from ${handoffBaseLine(handoff, 8)}.` : diff);
      return;
    }
    case 'merge': {
      // A run still going keeps its branches for the tasks still to land (ADR-0020).
      await confirmed((group
        ? `Merge ${branch} into ${mergeTarget(handoff)}? Nothing is merged unless every repository can take it${checkoutRule(handoff) ? ' and is on that branch' : ''}; once a finished run has merged everything, its worktrees and branches are removed.`
        : `Merge ${branch} into ${mergeTarget(handoff)}?${checkoutRule(handoff)} Once a finished run has merged everything, its worktrees and branches are removed.`) + repairedNotice(handoff));
      // Work whose check has not passed is the daemon's to name: it refuses, and the yes comes in a second request (ADR-0055 D9).
      // --yes covers the first question only; this one is answered by --past-checks or by a person.
      let pastChecks = hasFlag(subArgs, '--past-checks');
      const merged = await attempt(async () => {
        try {
          return await api.mergeRun(sessionId, pastChecks ? { pastChecks: true } : {});
        } catch (err) {
          if (!(err instanceof DaemonError) || err.code !== 'merge_past_check') throw err;
          if (!(await confirm(`${err.message} Merge anyway?`))) return null;
          pastChecks = true;
          return api.mergeRun(sessionId, { pastChecks: true });
        }
      });
      if (merged === null) fail('Not confirmed: nothing was changed. Pass --past-checks to merge past a check that has not passed.');
      const { ok, message } = mergeOutcome(merged, branch, group, repairedLanded(handoff));
      if (ok) console.log(message);
      else fail(message);
      return;
    }
    case 'discard':
      await confirmed(group
        ? `Discard this run's worktrees and task branches, and delete ${branch} in every repository?`
        : `Discard this run's worktrees and task branches, and delete ${branch}?`);
      await attempt(() => api.discardRun(sessionId));
      console.log(`Discarded the run and ${branch}${group ? ' in every repository' : ''}.`);
      return;
    case 'cleanup':
      await attempt(() => api.cleanupRun(sessionId));
      console.log(`Removed the run's worktrees and task branches; ${branch} is kept${group ? ' in every repository' : ''}.`);
      return;
  }
}
