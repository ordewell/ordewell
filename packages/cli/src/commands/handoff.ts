import { hasFlag, positionals } from '../utils';
import { type ApiClient } from '../apiClient';
import { DaemonRefusal } from '@ordewell/core';
import { DELEGATION_OFFERED, checkoutRule, handoffBaseLine, handoffBranchName, isRepoGroup, isolationViewOfPlan, mergeOutcome, mergeTarget, repairedLanded, repairedNotice, repoResultLines } from '@ordewell/core';
import { HANDOFF_ACTIONS } from '../tui/handoff';
import { adopted } from './conversation';
import { askYesNo, fail } from './shared';

// The flag is named only where delegation is offered: a check that has not passed exists nowhere else (ADR-0055 D21).
const USAGE = `Usage: ordewell handoff [review|merge|discard|cleanup] [--session-id <id>] [--workspace /path] [--yes]${DELEGATION_OFFERED ? ' [--past-checks]' : ''} [--beside-ops]`;

/**
 * Land an isolated run's branch (ADR-0013) — the terminal counterpart of the
 * TUI's `/merge`. Merge and discard are the steps that cannot be undone, so
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
      // Work whose check has not passed (ADR-0055 D9), and ops tasks running in the checkout (ADR-0020), are the
      // daemon's to name: it refuses, one question at a time, and each yes comes in the next request.
      // --yes covers the first question only; these are answered by --past-checks and --beside-ops, or by a person.
      const yes = { pastChecks: hasFlag(subArgs, '--past-checks'), besideOps: hasFlag(subArgs, '--beside-ops') };
      const flags = { pastChecks: '--past-checks to merge past a check that has not passed', besideOps: '--beside-ops to merge beside an ops task running in your checkout' };
      let declined: keyof typeof yes = 'pastChecks';
      const merged = await attempt(async () => {
        for (;;) {
          try {
            return await api.mergeRun(sessionId, { ...(yes.pastChecks ? { pastChecks: true } : {}), ...(yes.besideOps ? { besideOps: true } : {}) });
          } catch (err) {
            if (!(err instanceof DaemonRefusal)) throw err;
            const asked = err.code === 'merge_past_check' ? 'pastChecks' : err.code === 'merge_beside_ops' ? 'besideOps' : null;
            // A question already answered yes and asked again is not one a person can settle here.
            if (asked === null || yes[asked]) throw err;
            if (!(await confirm(`${err.message} Merge anyway?`))) { declined = asked; return null; }
            yes[asked] = true;
          }
        }
      });
      if (merged === null) fail(`Not confirmed: nothing was changed. Pass ${flags[declined]}.`);
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
