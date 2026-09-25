import type { Effect, Step } from './reducer';
import { say } from './transcript';
import { sanitize } from './ansi';
import type { Key } from './keys';
import type { PlanIsolationView } from '../isolation';
import type { HandoffView, Overlay, PickerItem, TaskIsolationView, TaskView, TuiState } from './state';

/**
 * The end-of-run handoff (ADR-0013): the run's work sits on one branch, and
 * landing it is the user's call. Everything here is reducer-side — the overlay's
 * state, its keys, and which effect each choice becomes. Nothing in it merges
 * on its own: the merge is a confirm away, every time.
 */
export const HANDOFF_ACTIONS = [
  { id: 'review', label: 'Review diff', hint: 'the branch against the commit it forked from' },
  { id: 'merge', label: 'Merge', hint: 'into the branch you have checked out — asks first' },
  { id: 'discard', label: 'Discard', hint: 'the run, its worktrees and this branch — asks first' },
  { id: 'cleanup', label: 'Clean up', hint: 'remove worktrees and task branches, keep this branch' },
] as const;

export type HandoffActionId = (typeof HANDOFF_ACTIONS)[number]['id'];

export const HANDOFF_USAGE = `/handoff [${HANDOFF_ACTIONS.map((a) => a.id).join('|')}]`;

/** Lines of diff the overlay shows at once, given the rows its frame gets: title, blank, footer. */
export const diffRoom = (rows: number): number => Math.max(1, rows - 3);

const fail = (state: TuiState, content: string): Step => ({ state: say(state, 'error', content), effects: [] });

/** `/handoff` alone opens the overlay; `/handoff <action>` takes that action without the detour. */
export function handoffCommand(state: TuiState, arg: string | undefined): Step {
  if (!state.sessionId || !state.handoff) return fail(state, 'No isolated run to hand off — a plan that ran in worktrees leaves one here.');
  if (arg === undefined) return { state: { ...state, overlay: { kind: 'handoff', index: 0, diff: null } }, effects: [] };
  const action = HANDOFF_ACTIONS.find((a) => a.id === arg.toLowerCase());
  if (!action) return fail(state, `Usage: ${HANDOFF_USAGE}`);
  return runHandoffAction(state, action.id);
}

/** A run just settled with work on a branch. Interrupts only a screen with nothing else on it. */
export function handoffArrived(state: TuiState, handoff: HandoffView): TuiState {
  const landed = handoff.landed.length;
  const told = say(
    { ...state, handoff },
    'system',
    `Run finished on ${handoff.branch} — ${landed} task${landed === 1 ? '' : 's'} landed. /handoff to review and land it.`,
  );
  return state.overlay ? told : { ...told, overlay: { kind: 'handoff', index: 0, diff: null } };
}

export function runHandoffAction(state: TuiState, id: HandoffActionId): Step {
  const { sessionId, handoff } = state;
  if (!sessionId || !handoff) return fail(state, 'No isolated run to hand off.');
  const closed: TuiState = { ...state, overlay: null };

  switch (id) {
    case 'review':
      return { state, effects: [{ type: 'isolationReviewDiff', sessionId }] };
    case 'cleanup':
      return { state: closed, effects: [{ type: 'isolationCleanup', sessionId, branch: handoff.branch }] };
    case 'merge':
      return {
        state: {
          ...state,
          overlay: {
            kind: 'confirm',
            title: 'Merge into your branch?',
            message: `Merge ${handoff.branch} into whatever you have checked out. Ordewell never does this on its own. If it conflicts the merge is aborted and your tree stays as it was.`,
            action: { kind: 'merge-run' },
          },
        },
        effects: [],
      };
    case 'discard':
      return {
        state: {
          ...state,
          overlay: {
            kind: 'confirm',
            title: 'Discard this run?',
            message: `Removes the run's worktrees and task branches and deletes ${handoff.branch}. Tasks keep their status — mark one not done if you did not keep its work.`,
            action: { kind: 'discard-run' },
          },
        },
        effects: [],
      };
  }
}

/** Answers `merge-run` / `discard-run` confirmations. */
export function confirmedHandoff(state: TuiState, kind: 'merge-run' | 'discard-run'): Step {
  const closed: TuiState = { ...state, overlay: null };
  if (!state.sessionId || !state.handoff) return { state: closed, effects: [] };
  const { sessionId, handoff } = state;
  const effect: Effect = kind === 'merge-run'
    ? { type: 'isolationMerge', sessionId, branch: handoff.branch }
    : { type: 'isolationDiscard', sessionId, branch: handoff.branch };
  return { state: closed, effects: [effect] };
}

/** The diff arrived: show it in the overlay, opening it if the request came from `/handoff review`. */
export function showDiff(state: TuiState, diff: string): TuiState {
  if (diff.trim() === '') return say(state, 'system', `Nothing differs from ${state.handoff?.baseRef.slice(0, 8) ?? 'the base commit'}.`);
  const index = state.overlay?.kind === 'handoff' ? state.overlay.index : 0;
  // Tabs are expanded before sanitizing, which would turn each into one space
  // and flatten tab-indented code — the one thing a review needs to read.
  const lines = sanitize(diff.replace(/\t/g, '    ')).split('\n');
  return { ...state, overlay: { kind: 'handoff', index, diff: { lines, scroll: 0 } } };
}

export function handleHandoffKey(
  state: TuiState,
  overlay: Extract<Overlay, { kind: 'handoff' }>,
  key: Key,
  rows: number,
): Step {
  const hold = { state, effects: [] };
  const up = key.name === 'up' || key.name === 'scrollup';
  const down = key.name === 'down' || key.name === 'scrolldown';

  if (overlay.diff) {
    const { lines, scroll } = overlay.diff;
    const room = diffRoom(rows);
    const max = Math.max(0, lines.length - room);
    const delta = up ? -1 : down ? 1 : key.name === 'pageup' ? -room : key.name === 'pagedown' ? room : null;
    if (delta !== null) {
      const next = Math.min(max, Math.max(0, scroll + delta));
      return { state: { ...state, overlay: { ...overlay, diff: { lines, scroll: next } } }, effects: [] };
    }
    // Any other key steps back to the actions: the diff is a detour, not a place to get stuck.
    if (key.name === 'escape' || key.name === 'enter') return { state: { ...state, overlay: { ...overlay, diff: null } }, effects: [] };
    return hold;
  }

  if (key.name === 'escape') return { state: { ...state, overlay: null }, effects: [] };
  if (up || down) {
    const index = Math.min(HANDOFF_ACTIONS.length - 1, Math.max(0, overlay.index + (up ? -1 : 1)));
    return { state: { ...state, overlay: { ...overlay, index } }, effects: [] };
  }
  if (key.name === 'enter') return runHandoffAction(state, HANDOFF_ACTIONS[overlay.index].id);
  return hold;
}

// ── A run a dirty tree turned away ───────────────────────────────────────────

const BLOCKED_ITEMS: PickerItem[] = [
  { id: 'stash', label: 'Stash and continue', detail: 'git stash your tracked changes, then run in worktrees' },
  { id: 'shared', label: 'Run without isolation', detail: 'this run only, in your working tree' },
  { id: 'cancel', label: 'Cancel', detail: 'start nothing' },
];

export type BlockedChoice = 'stash' | 'shared' | 'cancel';

export function blockedPicker(state: TuiState, message: string): TuiState {
  return {
    ...state,
    overlay: {
      kind: 'picker',
      picker: {
        title: 'Run blocked by uncommitted changes',
        hint: message,
        items: BLOCKED_ITEMS,
        filter: '',
        index: 0,
        multi: false,
        chosen: [],
        action: { kind: 'isolation-blocked' },
      },
    },
  };
}

export function chooseBlocked(state: TuiState, choice: BlockedChoice): Step {
  const closed: TuiState = { ...state, overlay: null };
  if (!state.sessionId) return { state: closed, effects: [] };
  const { sessionId } = state;
  // The run is parked in the daemon until it hears one of these; stopping is what
  // un-parks it, or a later /run would find the start silently swallowed.
  if (choice === 'cancel') return { state: closed, effects: [{ type: 'stopExecution', sessionId }] };
  return { state: closed, effects: [{ type: 'isolationContinue', sessionId, mode: choice }] };
}

// ── Per-task isolation on the plan pane ──────────────────────────────────────

export function sameIsolation(a: TaskIsolationView | undefined, b: TaskIsolationView | undefined): boolean {
  return a?.state === b?.state && a?.branch === b?.branch && a?.worktree === b?.worktree;
}

function mapTasks(tasks: TaskView[], map: (task: TaskView) => TaskView): TaskView[] {
  return tasks.map((task) => {
    const mapped = map(task);
    return task.subtasks ? { ...mapped, subtasks: mapTasks(task.subtasks, map) } : mapped;
  });
}

/** Isolation belongs to one session's run: forget it all, the handoff and every task's mark. */
export function clearIsolation(state: TuiState): TuiState {
  return {
    ...state,
    handoff: null,
    tasks: mapTasks(state.tasks, ({ isolation: _dropped, ...task }) => task),
  };
}

/**
 * Freshly normalized tasks with their isolation put back: from the saved plan's
 * run record when it came with one, else from what the tasks they replace showed.
 */
export function isolationForPlan(tasks: TaskView[], record: PlanIsolationView | null, previous: TaskView[]): TaskView[] {
  const known = new Map<string, TaskIsolationView>();
  mapTasks(previous, (task) => {
    if (task.isolation) known.set(task.id, task.isolation);
    return task;
  });
  return mapTasks(tasks, (task) => {
    const isolation = record ? (record.tasks[task.id] ?? { state: 'none' as const }) : known.get(task.id);
    return isolation ? { ...task, isolation } : task;
  });
}
