import type { Effect, MergeYes, Step } from './reducers/shared';
import { say } from './transcript';
import { sanitize } from './ansi';
import type { Key } from './keys';
import { checkoutRule, handoffBaseLine, handoffBranchName, isRepoGroup, mergeOutcome, mergeTarget, repairedLanded, repairedNotice } from '@ordewell/core';
import type { IsolationMergeResult } from '@ordewell/core';
import type { HandoffView, Overlay, PickerItem, TuiState } from './state';

/**
 * The end-of-run handoff (ADR-0013): the run's work sits on one branch, and
 * landing it is the user's call unless they opted in to merging automatically.
 * Everything here is reducer-side — the overlay's state, its keys, and which
 * effect each choice becomes. Nothing in it merges without a confirm.
 */
export const HANDOFF_ACTIONS = [
  { id: 'review', label: 'Review diff', hint: 'the branch against the commit it forked from' },
  { id: 'merge', label: 'Merge', hint: 'into the branch you have checked out (asks first)' },
  { id: 'discard', label: 'Discard', hint: 'the run, its worktrees and this branch (asks first)' },
  { id: 'cleanup', label: 'Clean up', hint: 'remove worktrees and task branches, keep this branch' },
] as const;

export type HandoffActionId = (typeof HANDOFF_ACTIONS)[number]['id'];

/** The actions as the overlay words them: a run over a repo group acts on every repo at once. */
export function handoffActions(handoff: HandoffView): ReadonlyArray<{ id: HandoffActionId; label: string; hint: string }> {
  if (!isRepoGroup(handoff)) return HANDOFF_ACTIONS;
  return [
    { id: 'review', label: 'Review diff', hint: "each repository's branch against the commit it forked from" },
    { id: 'merge', label: 'Merge all', hint: "every repository's branch into what you have checked out there (asks first)" },
    { id: 'discard', label: 'Discard', hint: "the run, its worktrees and every repository's branch (asks first)" },
    { id: 'cleanup', label: 'Clean up', hint: 'remove worktrees and task branches everywhere, keep the integration branches' },
  ];
}

const reposOf = (handoff: HandoffView): string => handoff.repos.map((r) => r.path).join(', ');

/** Merge is the bare command, so the usage names the other three; `/merge merge` still works for the sake of the old `/handoff merge`. */
export const HANDOFF_USAGE = `/merge [${HANDOFF_ACTIONS.filter((a) => a.id !== 'merge').map((a) => a.id).join('|')}]`;

/** The overlay opens on Merge, the action `/merge` is named for: Enter asks the confirmation. */
const MERGE_INDEX = HANDOFF_ACTIONS.findIndex((a) => a.id === 'merge');

/** Lines of diff the overlay shows at once, given the rows its frame gets: title, blank, footer. */
export const diffRoom = (rows: number): number => Math.max(1, rows - 3);

const fail = (state: TuiState, content: string): Step => ({ state: say(state, 'error', content), effects: [] });

/**
 * A previous handoff may still be cached while a resumed run merges its work.
 * During execution only the current merge view knows what remains unmerged.
 */
export function currentHandoff(state: TuiState): HandoffView | null {
  return state.runMerge?.handoff ?? (midRun(state) ? null : state.handoff);
}

/** A merge while the run is still going leaves the run in place: its later tasks land on the same branch. */
const midRun = (state: TuiState): boolean => state.status === 'executing';

/**
 * `/merge` alone opens the overlay on Merge; `/merge <action>` takes that
 * action without the detour. Mid-run the overlay would only be a detour to the
 * one thing on offer, a merge that leaves the run going, so it asks that directly.
 */
export function handoffCommand(state: TuiState, arg: string | undefined): Step {
  if (!state.sessionId || !currentHandoff(state)) return fail(state, 'No isolated run to merge: a plan that ran in worktrees leaves one here.');
  if (arg === undefined) {
    return midRun(state)
      ? runHandoffAction(state, 'merge')
      : { state: { ...state, overlay: { kind: 'handoff', index: MERGE_INDEX, diff: null } }, effects: [] };
  }
  const action = HANDOFF_ACTIONS.find((a) => a.id === arg.toLowerCase());
  if (!action) return fail(state, `Usage: ${HANDOFF_USAGE}`);
  return runHandoffAction(state, action.id);
}

/**
 * A run just settled with work on a branch. Interrupts only a screen with
 * nothing else on it — and not at all when an Act supervisor looks at the run
 * first: it may merge it, and a pop-up would be dismissed for nothing.
 */
export function handoffArrived(state: TuiState, handoff: HandoffView): TuiState {
  const landed = handoff.landed.length;
  const where = isRepoGroup(handoff) ? ` in ${reposOf(handoff)}` : '';
  const branch = handoffBranchName(handoff);
  const tasks = `${landed} task${landed === 1 ? '' : 's'} landed`;
  const received = { ...state, handoff };

  if (handoff.deferredTo === 'supervisor') {
    return say(received, 'system', `Run finished on ${branch}${where}: ${tasks}. The supervisor may merge it; /merge to review it yourself.`);
  }
  const returned = state.handoff?.deferredTo === 'supervisor' && handoffBranchName(state.handoff) === branch;
  const told = say(
    received,
    'system',
    returned
      ? `The supervisor left ${branch}${where} to you: ${tasks}. /merge to review and land it.`
      : `Run finished on ${branch}${where}: ${tasks}. /merge to review and land it.`,
  );
  return state.overlay ? told : { ...told, overlay: { kind: 'handoff', index: 0, diff: null } };
}

export function runHandoffAction(state: TuiState, id: HandoffActionId): Step {
  const { sessionId } = state;
  const handoff = currentHandoff(state);
  if (!sessionId || !handoff) return fail(state, 'No isolated run to merge.');
  const closed: TuiState = { ...state, overlay: null };

  switch (id) {
    case 'review':
      return { state, effects: [{ type: 'isolationReviewDiff', sessionId }] };
    case 'cleanup':
      return { state: closed, effects: [{ type: 'isolationCleanup', sessionId, branch: handoffBranchName(handoff) }] };
    case 'merge':
      if (midRun(state)) {
        return {
          state: {
            ...state,
            overlay: {
              kind: 'confirm',
              title: isRepoGroup(handoff) ? 'Merge what has landed into your branches?' : 'Merge what has landed into your branch?',
              message: `Merge ${handoffBranchName(handoff)} as it stands now into ${mergeTarget(handoff)}.${checkoutRule(handoff)} The run goes on: tasks waiting for Merge all start once it has merged, and later tasks land on the same branch for the next Merge all. A merge that conflicts is aborted, and your ${isRepoGroup(handoff) ? 'trees stay' : 'tree stays'} as ${isRepoGroup(handoff) ? 'they were' : 'it was'}.${repairedNotice(handoff)}`,
              action: { kind: 'merge-run' },
            },
          },
          effects: [],
        };
      }
      return {
        state: {
          ...state,
          overlay: isRepoGroup(handoff)
            ? {
              kind: 'confirm',
              title: 'Merge all into your branches?',
              message: `Merge ${handoffBranchName(handoff)} into ${mergeTarget(handoff)}.${checkoutRule(handoff)} It checks every repository first and merges none unless every repository can take it; on git older than 2.38 it goes repository by repository and stops at the first that fails. A merge that conflicts is aborted, and your trees stay as they were. Once every repository has merged, the run's worktrees and branches are removed unless a task still has work in its worktree that has not landed: then the run stays, and so does that work.${repairedNotice(handoff)}`,
              action: { kind: 'merge-run' },
            }
            : {
              kind: 'confirm',
              title: 'Merge into your branch?',
              message: `Merge ${handoffBranchName(handoff)} into ${mergeTarget(handoff)}.${checkoutRule(handoff)} If it conflicts the merge is aborted and your tree stays as it was. Once it has merged, the run's worktrees and branches are removed unless a task still has work in its worktree that has not landed: then the run stays, and so does that work.${repairedNotice(handoff)}`,
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
            message: `Removes the run's worktrees and task branches and deletes ${handoffBranchName(handoff)}${isRepoGroup(handoff) ? ` in ${reposOf(handoff)}` : ''}. Tasks keep their status: mark one not done if you did not keep its work.`,
            action: { kind: 'discard-run' },
          },
        },
        effects: [],
      };
  }
}

const HELD_TITLES: Record<keyof MergeYes, string> = {
  pastChecks: 'Merge past a check that has not passed?',
  besideOps: 'Merge beside a running ops task?',
};

/**
 * The question a Merge all raises when the daemon holds it for the user's say:
 * past a check that has not passed (ADR-0055 D9), or beside an ops task
 * running in the checkout (ADR-0020). What it holds for, as the daemon named
 * it, and a yes that sends `asked` with the merge beside the yes `given` to an
 * earlier question. Asked after the generic confirmation, which knows neither.
 */
export function askMergeHeld(state: TuiState, named: string, asked: keyof MergeYes, given: MergeYes = {}): TuiState {
  const handoff = currentHandoff(state);
  if (!handoff) return say(state, 'system', named);
  return {
    ...state,
    overlay: {
      kind: 'confirm',
      title: HELD_TITLES[asked],
      message: `${named} Merge ${handoffBranchName(handoff)} into ${mergeTarget(handoff)} anyway?`,
      action: { kind: 'merge-run', ...given, [asked]: true },
    },
  };
}

/** Answers `merge-run` / `discard-run` confirmations; `yes` is what a Merge all was asked past. */
export function confirmedHandoff(state: TuiState, kind: 'merge-run' | 'discard-run', yes: MergeYes = {}): Step {
  const closed: TuiState = { ...state, overlay: null };
  const handoff = currentHandoff(state);
  if (!state.sessionId || !handoff) return { state: closed, effects: [] };
  const { sessionId } = state;
  const repaired = repairedLanded(handoff);
  const effect: Effect = kind === 'merge-run'
    ? {
      type: 'isolationMerge', sessionId, branch: handoffBranchName(handoff),
      ...(isRepoGroup(handoff) ? { group: true } : {}),
      ...(repaired.length > 0 ? { repaired } : {}),
      ...(yes.pastChecks ? { pastChecks: true as const } : {}),
      ...(yes.besideOps ? { besideOps: true as const } : {}),
    }
    : { type: 'isolationDiscard', sessionId, branch: handoffBranchName(handoff) };
  return { state: kind === 'merge-run' ? { ...closed, mergeAsked: true } : closed, effects: [effect] };
}

/**
 * The words for a merge result this pane did not ask for: an automatic Merge
 * all that merged or was turned away (the only trace of why a conflict held
 * the run is here), the supervisor's, or another window's. The pane's own
 * request is answered in the words its HTTP reply brings, so its result, the
 * first heard after it was sent, says nothing; core's `mergeOutcome` words the
 * rest as /merge does.
 */
export function announceMerge(state: TuiState, result: IsolationMergeResult): TuiState {
  if (state.mergeAsked) return { ...state, mergeAsked: false };
  const handoff = state.runMerge?.handoff ?? state.handoff;
  const { ok, message } = mergeOutcome(result, handoff ? handoffBranchName(handoff) : 'the run\'s branch', handoff ? isRepoGroup(handoff) : false, handoff ? repairedLanded(handoff) : []);
  return say(state, ok ? 'system' : 'error', message);
}

/** The diff arrived: show it in the overlay, opening it if the request came from `/merge review`. */
export function showDiff(state: TuiState, diff: string): TuiState {
  const handoff = currentHandoff(state);
  if (diff.trim() === '') return say(state, 'system', `Nothing differs from ${handoff ? handoffBaseLine(handoff, 8) : 'the base commit'}.`);
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

/** `repos` names the dirty repos of a group; Stash acts on all of them. */
export function blockedPicker(state: TuiState, message: string, repos: string[] = []): TuiState {
  const items = repos.length === 0
    ? BLOCKED_ITEMS
    : BLOCKED_ITEMS.map((item) => (item.id === 'stash'
      ? { ...item, detail: `git stash the tracked changes in ${repos.join(', ')}, then run in worktrees` }
      : item));
  return {
    ...state,
    overlay: {
      kind: 'picker',
      picker: {
        title: 'Run blocked by uncommitted changes',
        hint: message,
        items,
        filter: '',
        index: 0,
        multi: false,
        chosen: [],
        filterable: false,
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

