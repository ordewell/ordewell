import { markAction, resumeLabel, taskRowView } from '@ordewell/core';
import type { TaskView } from './state';

/**
 * The plan pane's keys, written down once. The key sheet (`?`) prints every
 * entry; the footer picks the few that fit the selected task from the same
 * entries, so a key renamed here is renamed in both and a key the footer
 * names cannot be missing from the sheet.
 *
 * Only the advertising lives here. What a key does is `reducers/planPane.ts`.
 */

export type PlanKeyGroup = 'Navigation' | 'Assign' | 'Run' | 'Status' | 'Other';

export interface PlanKey {
  keys: string;
  meaning: string;
  group: PlanKeyGroup;
  /** The footer's short form. A function where the label follows the selected task. */
  hint?: string | ((task: TaskView | undefined) => string);
}

// Object order is the sheet's order within a group.
export const PLAN_KEYS = {
  move: { keys: 'up / down', meaning: 'move between tasks', group: 'Navigation' },
  scroll: { keys: 'pgup / pgdn', meaning: 'scroll the plan', group: 'Navigation' },
  expand: { keys: '→', meaning: "reveal a task's subtasks, then edit its prompt, or show a script task's body", group: 'Navigation', hint: '→ expand' },
  log: {
    keys: 'enter',
    meaning: "open the task's log: its output for a script task, or the chat with its runner (and, at a checkpoint, its answer)",
    group: 'Navigation',
    hint: (task) => (task?.type === 'script' ? 'enter output' : task?.status === 'awaiting_user' && task.awaitingReason === 'checkpoint' ? 'enter answer' : 'enter chat'),
  },
  back: { keys: 'esc', meaning: "collapse the task, or leave a task's chat for the plan", group: 'Navigation' },

  runner: { keys: 'R', meaning: "pick the task's runner", group: 'Assign' },
  model: { keys: 'o', meaning: "pick the task's model", group: 'Assign', hint: 'o model' },
  effort: { keys: 'e', meaning: "pick the task's effort", group: 'Assign', hint: 'e effort' },
  mode: { keys: 'M', meaning: "pick the task's mode", group: 'Assign' },
  deps: { keys: 'D', meaning: 'pick the tasks it depends on', group: 'Assign' },
  skills: { keys: 'K', meaning: 'pick the skills it loads', group: 'Assign' },
  ops: { keys: 'O', meaning: 'switch between a change and an ops task', group: 'Assign' },

  start: {
    keys: 'f',
    meaning: 'start the task, approving it if it waits for you; it starts once its dependencies finish',
    group: 'Run',
    // Added after the plan was approved, it waits for this key; the row says the same.
    hint: (task) => (task && taskRowView(task).waitsForApproval ? 'f approve' : 'f start'),
  },
  runPlan: { keys: 'E', meaning: 'run the whole plan', group: 'Run', hint: 'E run plan' },
  stop: { keys: 'S', meaning: 'stop the run', group: 'Run', hint: 'S stop' },
  cancel: {
    keys: 'c',
    meaning: "cancel the task's runner, withdraw a conflict repair waiting to start, or keep a task paused on a usage limit from resuming on its own",
    group: 'Run',
    // `c` cancels the resume while the task has one; it has no runner to cancel then.
    hint: (task) => (task && resumeLabel(task) ? 'c don\'t resume' : task && taskRowView(task).repairWaiting ? 'c stop repair' : 'c cancel'),
  },
  resume: { keys: 'r', meaning: 'resume a task paused on a usage limit now, once the limit has reset', group: 'Run', hint: 'r resume now' },
  resolve: { keys: 'x', meaning: 'resolve a merge conflict', group: 'Run', hint: 'x resolve conflict' },
  retry: { keys: '/retry', meaning: 'run a failed task again (type it in the chat)', group: 'Run', hint: '/retry' },

  mark: {
    keys: 'm',
    meaning: 'mark the task done, or take it back',
    group: 'Status',
    // `m` toggles, so the hint names the direction it will go for this task.
    hint: (task) => (task && markAction(task) === 'uncomplete' ? 'm undone' : 'm done'),
  },
  skip: { keys: 's', meaning: 'skip the task: none of its work lands, and what depends on it goes ahead', group: 'Status', hint: 's skip' },
  remove: { keys: 'd', meaning: 'remove the task', group: 'Status' },
  add: { keys: 'a', meaning: 'add a task', group: 'Status', hint: 'a add' },

  keys: { keys: '?', meaning: 'show this sheet', group: 'Other', hint: '? keys' },
  chat: { keys: 'tab', meaning: 'switch to the chat', group: 'Other', hint: 'tab chat' },
} satisfies Record<string, PlanKey>;

export type PlanKeyId = keyof typeof PLAN_KEYS;

/** Keys while a task's prompt editor is open; they type into a draft, so none of the above apply. */
export const TASK_EDITOR_KEYS: readonly { keys: string; meaning: string }[] = [
  { keys: 'enter', meaning: 'save the prompt' },
  { keys: 'alt-enter', meaning: 'insert a newline' },
  { keys: 'esc', meaning: 'discard the edit' },
  { keys: 'pgup / pgdn', meaning: 'scroll the plan' },
];

const GROUPS: readonly PlanKeyGroup[] = ['Navigation', 'Assign', 'Run', 'Status', 'Other'];

export function planKeysByGroup(): [PlanKeyGroup, PlanKey[]][] {
  const entries: PlanKey[] = Object.values(PLAN_KEYS);
  return GROUPS.map((group) => [group, entries.filter((entry) => entry.group === group)]);
}

function hintOf(id: PlanKeyId, task: TaskView | undefined): string {
  const entry: PlanKey = PLAN_KEYS[id];
  const { hint } = entry;
  if (hint === undefined) return entry.keys;
  return typeof hint === 'function' ? hint(task) : hint;
}

/** What the selected task can actually be asked to do, most useful first. */
function taskKeyIds(task: TaskView | undefined, runActive: boolean): PlanKeyId[] {
  if (!task) return ['add'];
  const row = taskRowView(task);
  // Only a started task has a chat to enter; its status or a manual mark is not one.
  const chat = (...ids: PlanKeyId[]): PlanKeyId[] => (row.chatAvailable ? ids : ids.filter((id) => id !== 'log'));
  // A resolver has the conflict: a second is refused, so it is not offered.
  if (row.conflict) return row.conflict.resolver ? chat('log') : chat('resolve', 'log');
  if (row.repairWaiting) return chat('cancel', 'log');
  if (row.actions.includes('resume-now') || row.resumes) {
    return chat(...(row.actions.includes('resume-now') ? ['resume' as const] : []), ...(row.resumes ? ['cancel' as const] : []), 'skip', 'log');
  }
  switch (row.status) {
    case 'running':
    case 'quiet':
      return chat(...(runActive ? ['log' as const, 'cancel' as const, 'stop' as const] : ['log' as const, 'cancel' as const]));
    case 'awaiting': return chat('log', 'mark', 'skip');
    case 'failed': return chat('retry', 'skip', 'log');
    case 'skipped':
    case 'done': return chat('mark', 'log');
    case 'blocked': return chat('start', 'skip', 'runPlan', 'log');
    // A manual task and a script task have no model to pick.
    default: return row.kind === 'user' ? ['mark', 'runPlan'] : row.kind === 'script' ? chat('log', 'start', 'runPlan') : chat('log', 'start', 'runPlan', 'model', 'effort');
  }
}

/** The plan footer's hints for the selected task, ending in the keys that are always there. */
export function planFooterHints(task: TaskView | undefined, runActive: boolean): string[] {
  const ids: PlanKeyId[] = [...taskKeyIds(task, runActive), 'expand', 'keys', 'chat'];
  return ids.map((id) => hintOf(id, task));
}
