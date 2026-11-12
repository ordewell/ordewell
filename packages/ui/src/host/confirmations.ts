import type { GlobalRunSettings, OverrideDirection, RevertPreviewTask, Task } from '@ordewell/core';
import {
  ACT_RISK, AUTORUN_RISK, DELEGATION_RISK, SUBPLANNER_ACCOUNTING, SUBPLANNER_CHILD,
  dependentsNotice, dependentsOf, loopLeaveNotice, manualOverrideConfirmation, pastGateConfirmation,
  revertEffect, revertListLine, revertTaskRef,
} from '@ordewell/core/plan-utils';

/** One answer a person can give, as its button says it. */
export interface ConfirmationChoice<C extends string> {
  id: C;
  label: string;
}

/**
 * A question the view cannot ask itself. A sandboxed webview's `confirm()` is
 * inert and only the host can name what changes, so the host asks it in its
 * own dialog. The words are decided here, once: every host shows the same
 * question, and no host can soften one. Dismissing the dialog answers none of
 * the choices, which every caller reads as no.
 */
export interface ConfirmationRequest<C extends string = string> {
  kind: ConfirmationKind;
  message: string;
  detail?: string;
  /** In the order offered. */
  choices: readonly ConfirmationChoice<C>[];
}

export type ConfirmationKind =
  | 'remove_task' | 'start_past_gate' | 'manual_override' | 'revert_task'
  | 'isolation_blocked' | 'merge_all' | 'merge_past_checks' | 'merge_beside_ops' | 'discard_run'
  | 'run_setting_risk' | 'fork_stops_run' | 'discard_changes';

function yes<C extends string>(kind: ConfirmationKind, message: string, id: C, label: string, detail?: string): ConfirmationRequest<C> {
  return { kind, message, ...(detail !== undefined ? { detail } : {}), choices: [{ id, label }] };
}

/** `tasks` is the plan the removal would change, so the dependents and the loop it leaves are named. */
export function removeTaskConfirmation(tasks: readonly Task[], taskId: string): ConfirmationRequest<'remove'> {
  return yes('remove_task', removalPrompt(tasks, taskId), 'remove', 'Remove');
}

export function removalPrompt(tasks: readonly Task[], taskId: string): string {
  const all = flatten(tasks);
  const title = all.find((t) => t.id === taskId)?.title;
  const question = title ? `Remove "${title}"?` : 'Remove this task?';
  const notice = [dependentsNotice(dependentsOf(tasks, taskId), tasks), loopLeaveNotice(tasks, taskId)].filter(Boolean).join(' ');
  return notice ? `${question}\n\n${notice}` : question;
}

function flatten(tasks: readonly Task[]): Task[] {
  return tasks.flatMap((t) => [t, ...flatten(t.subtasks ?? [])]);
}

/** `unmerged` names the gating tasks as the person knows them, `#2 Build`. */
export function startPastGateConfirmation(unmerged: readonly string[]): ConfirmationRequest<'start'> {
  return yes('start_past_gate', pastGateConfirmation(unmerged), 'start', 'Start anyway');
}

export function overrideConfirmation(direction: OverrideDirection, label: string): ConfirmationRequest<'override'> {
  return yes('manual_override', manualOverrideConfirmation(direction, label), 'override', direction === 'complete' ? 'Mark complete' : 'Mark not done');
}

/** What a revert takes with it, newest first, from core's preview: the yes is for that list. */
export function revertConfirmation(preview: { tasks: readonly RevertPreviewTask[] }, taskId: string): ConfirmationRequest<'revert'> {
  const asked = preview.tasks.find((t) => t.taskId === taskId) ?? preview.tasks.at(-1);
  const list = preview.tasks.map(revertListLine);
  return yes(
    'revert_task',
    `Revert task ${asked ? `${revertTaskRef(asked)} ${asked.title}` : 'this task'}? ${revertEffect}`,
    'revert',
    'Revert',
    `Reverting, newest first:\n${list.join('\n')}`,
  );
}

export type IsolationBlockedChoice = 'stash' | 'shared_root' | 'cancel';

/**
 * A dirty tree parked an isolated run. Stashing changes the user's real tree,
 * so the question names the alternative rather than offering only a yes.
 */
export function isolationBlockedConfirmation(message: string): ConfirmationRequest<IsolationBlockedChoice> {
  return {
    kind: 'isolation_blocked',
    message,
    choices: [
      { id: 'stash', label: 'Stash and continue' },
      { id: 'shared_root', label: 'Run without isolation' },
      { id: 'cancel', label: 'Cancel' },
    ],
  };
}

/**
 * Merge all, mid-run or once it is over (ADR-0020). `target` and `rule` are
 * the handoff's own wording, from core's `mergeTarget` and `checkoutRule`.
 */
export function mergeAllConfirmation(target: string, rule: string, midRun: boolean): ConfirmationRequest<'merge'> {
  return yes('merge_all', midRun
    ? `Merge what the run has landed so far into ${target}.${rule} This cannot be undone from Ordewell. The run goes on: tasks waiting for Merge all start once it has merged, and later tasks land on the same branch.`
    : `Merge the isolated run into ${target}.${rule} This cannot be undone from Ordewell. Once it has merged, the run's worktrees and branches are removed unless a task still has work in its worktree that has not landed: then the run stays, and so does that work.`,
  'merge', 'Merge');
}

/** The seam held the merge for work no check has passed (ADR-0055 D9): `held` is its own words. */
export function mergePastChecksQuestion(held: string, target: string): ConfirmationRequest<'merge'> {
  return yes('merge_past_checks', `${held} Merge ${target} anyway?`, 'merge', 'Merge anyway');
}

/** The seam held the user's merge for ops tasks running in their checkout (ADR-0020): `held` is its own words, naming them. */
export function mergeBesideOpsQuestion(held: string, target: string): ConfirmationRequest<'merge'> {
  return yes('merge_beside_ops', `${held} Merge ${target} anyway?`, 'merge', 'Merge anyway');
}

export function discardRunConfirmation(): ConfirmationRequest<'discard'> {
  return yes('discard_run', 'Discard the whole run? Its worktrees, task branches and integration branch are removed. Tasks it completed stay completed.', 'discard', 'Discard');
}

/** The user's own uncommitted changes (ADR-0062 G3): the files shown are echoed back with the action. */
export function discardChangesConfirmation(files: readonly string[]): ConfirmationRequest<'discard'> {
  const what = files.length === 1 ? files[0]! : `${files.length} files`;
  return yes('discard_changes', `Discard the changes to ${what}?`, 'discard', 'Discard', files.join('\n'));
}

/**
 * What turning Act, autorun or Subplanners on asks first (ADR-0030), in the
 * order asked: a no to any keeps the whole change. `delegationTokens` is the
 * budget now, so a change to one already on asks nothing new. Whether
 * Subplanners are offered at all is the host's to read (ADR-0055 D21), not a
 * view's.
 */
export function runSettingRiskConfirmations(
  changes: Partial<GlobalRunSettings>,
  delegationTokens: number,
  delegationOffered: boolean,
): ConfirmationRequest<'accept'>[] {
  const asked: ConfirmationRequest<'accept'>[] = [];
  if (changes.supervisorLevel === 'act') {
    asked.push(yes('run_setting_risk', 'Let the supervisor act?', 'accept', 'Let it act', `At Act the supervisor runs, stops and retries tasks, edits the plan and merges, without asking you. ${ACT_RISK}`));
  }
  if (changes.autorun === true) {
    asked.push(yes('run_setting_risk', 'Start plans without review?', 'accept', 'Turn autorun on', `Each plan the planner submits starts at once, as if you had pressed Execute. ${AUTORUN_RISK}`));
  }
  if (delegationOffered && delegationTokens === 0 && (changes.delegationTokens ?? 0) > 0) {
    asked.push(yes('run_setting_risk', 'Turn Subplanners on?', 'accept', 'Turn Subplanners on', `A tree of plans may spend up to ${changes.delegationTokens} tokens. ${SUBPLANNER_ACCOUNTING} ${SUBPLANNER_CHILD} ${DELEGATION_RISK}`));
  }
  return asked;
}

/** Loading a fork replaces the plan and stops the run, which the user would otherwise learn only after the fact. */
export function forkStopsRunConfirmation(): ConfirmationRequest<'fork'> {
  return yes('fork_stops_run', 'A run is executing. Switching to the fork stops it; the original session is kept as it is.', 'fork', 'Fork and stop the run');
}
