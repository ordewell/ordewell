import { createInterface } from 'readline';
import { hasFlag, positionals } from '../utils';
import type { ApiClient } from '../daemonClient';
import { handoffBase, handoffBranch, isolationOfPlan, isRepoGroup, mergeOutcome, repoResultLines, reposWithWork } from '../isolation';
import { HANDOFF_ACTIONS } from '../tui/handoff';
import { adopted } from './conversation';
import { fail } from './shared';

const USAGE = 'Usage: ordewell handoff [review|merge|discard|cleanup] [--session-id <id>] [--workspace /path] [--yes]';

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

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
    for (const a of HANDOFF_ACTIONS) console.log(`  ${a.id.padEnd(8)} ${a.label} — ${a.hint}`);
    return;
  }
  if (!HANDOFF_ACTIONS.some((a) => a.id === action)) fail(`Unknown handoff action "${action}".`, USAGE);

  const { api, sessionId, plan } = await adopted(subArgs, injectedApi);
  const handoff = isolationOfPlan(plan)?.handoff;
  if (!handoff) fail('This session has no isolated run to hand off.');
  const branch = handoffBranch(handoff);
  const group = isRepoGroup(handoff);
  if (group) for (const line of repoResultLines(handoff)) console.error(line);

  const asked = hasFlag(subArgs, '--yes');
  const confirmed = async (question: string): Promise<void> => {
    if (asked || (await confirm(question))) return;
    fail('Not confirmed — nothing was changed. Pass --yes to confirm without a prompt.');
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
      console.log(diff.trim() === '' ? `Nothing differs from ${handoffBase(handoff, 8)}.` : diff);
      return;
    }
    case 'merge': {
      await confirmed(group
        ? `Merge ${branch} into the branch checked out in each of ${reposWithWork(handoff).join(', ')}? Nothing is merged unless every repository can take it.`
        : `Merge ${branch} into the branch you have checked out?`);
      const { ok, message } = mergeOutcome(await attempt(() => api.mergeRun(sessionId)), branch, group);
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
