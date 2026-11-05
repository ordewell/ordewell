import { aheadOfDraft, parseCount, type ChildPlanEntry, type ChildPlanView, type DaemonErrorCode, type RunTask } from '@ordewell/core';
import type { Key } from '../keys';
import { initialState, questionAbove, rootFrame, viewOnly, type TuiState } from '../state';
import { say } from '../transcript';
import { scrollChat, scrollDelta, settlePanes } from './pointer';
import { answerCheckpoint, openTaskView } from './taskView';
import { answerWords, reportError, stale, step, type Action, type Effect, type Step } from './shared';

/**
 * What every plan on screen has in common: the terminal, the daemon's catalogue
 * and the person's settings. Everything else on `TuiState` belongs to the plan
 * being viewed, so a new field is scoped to its plan until it is listed here.
 */
const SHARED_FIELDS = [
  'composerTipSeq', 'accountLimits', 'detailAll', 'runners', 'sessions', 'models', 'modesByRunner', 'taskSkills',
  'orchestratorModels', 'providerErrors', 'runnerErrors', 'orchestratorModel', 'plannerProvider', 'plannerEffort', 'plannerModels',
  'maxParallel', 'configuredProviders', 'allowlist', 'autonomous', 'runSettings', 'runSettingsKnown', 'settingsRead',
  'runSettingsRead', 'plannerKnown', 'runnersKnown', 'providersKnown', 'isolationPreview', 'isolationPreviewRead',
  'versionCheckNotice', 'mouseCapture', 'selection', 'workspace', 'overlay', 'pendingApprovals', 'toast', 'rows', 'cols',
  'exiting', 'spinnerFrame', 'now', 'childTree',
] as const satisfies ReadonlyArray<keyof TuiState>;

type SharedState = Pick<TuiState, (typeof SHARED_FIELDS)[number]>;

const shared = (state: TuiState): SharedState => Object.fromEntries(SHARED_FIELDS.map((field) => [field, state[field]])) as unknown as SharedState;

const VIEW_ONLY = 'This plan has ended: it can be read, not spoken to. Esc goes back to the plan above it.';
const BELONGS_ABOVE = 'A subplanner owns its plan: tell it what to change, or change it from the plan above.';
const NO_ROUTE = 'That has no route to a plan below the root: go back with Esc and act from the plan above.';
const RAISE_ABOVE = 'A raise is the plan above this one to give: answer without it here.';
const QUESTION_MOVED = 'That question has moved on: reading the plan again.';
const WORDS_KEPT = 'Your words are kept: Esc takes them to the composer of the plan above.';
const STOPS_THE_RUN = 'Stopping the whole run: a plan below the root has no stop of its own. A message waiting on a pause goes with it.';
const COMMANDS_HERE = new Set(['help', 'stop', 'quit']);

/** Whose stream a plan's frame came down: the root, whichever plan is viewed. */
export const rootId = (state: TuiState): string => rootFrame(state).sessionId ?? '';

/** The plan a task's child is read from. A fresh retry leaves the old child listed as ended, so one task can have two. */
function chosen(children: readonly ChildPlanEntry[], parent: string, taskId: string): ChildPlanEntry | null {
  const rows = children.filter((child) => child.parent === parent && child.taskId === taskId);
  return rows.filter((child) => child.state !== 'ended').at(-1) ?? rows.at(-1) ?? null;
}

function openChild(state: TuiState, entry: ChildPlanEntry): Step {
  return step(
    { ...initialState(), ...shared(state), sessionId: entry.sessionId, goal: entry.title, focus: 'chat', child: { entry, parent: state, reading: true, lost: false } },
    [{ type: 'followChild', rootId: rootId(state), childId: entry.sessionId }],
  );
}

/** Enter on a delegated task: the tree names its child, and only a tree that does not is asked. */
export function openDelegated(state: TuiState, sessionId: string, taskId: string): Step {
  const child = chosen(state.childTree, sessionId, taskId);
  return child ? openChild(state, child) : step(state, [{ type: 'listChildren', rootId: rootId(state), open: { parent: sessionId, taskId } }]);
}

/**
 * Back to the plan this one was opened from, as it was left and as its socket
 * has kept it since. An ended plan draws no composer, so the words it holds go
 * up with the person, to the first one that shows them.
 */
export function leaveChild(state: TuiState): Step {
  if (!state.child || !state.sessionId) return step(state);
  const above = { ...state.child.parent, ...shared(state) };
  return step(settlePanes(viewOnly(state) ? givenBack(above, state.editor.text) : above), [{ type: 'closeChild', childId: state.sessionId }]);
}

/** Every frame's row comes from the same list; a child it leaves out keeps its row, since its socket says if it is gone. */
function withTree(state: TuiState, children: ChildPlanEntry[]): TuiState {
  if (!state.child) return { ...state, childTree: children };
  const entry = children.find((child) => child.sessionId === state.sessionId) ?? state.child.entry;
  return { ...state, childTree: children, child: { ...state.child, entry, parent: withTree(state.child.parent, children) } };
}

export function childTreeArrived(state: TuiState, sessionId: string, children: ChildPlanEntry[]): TuiState {
  return rootId(state) === sessionId ? withTree(state, children) : state;
}

export function childrenListed(state: TuiState, action: Extract<Action, { type: 'childrenListed' }>): Step {
  const known = childTreeArrived(state, action.sessionId, action.children);
  const { open } = action;
  if (!open || known.sessionId !== open.parent) return step(known);
  const child = chosen(action.children, open.parent, open.taskId);
  return child ? openChild(known, child) : openTaskView(known, open.parent, open.taskId);
}

/** A read of the child is not the first any more: what it replaces is shown, and the socket's frames go on top of it. */
export function readLanded(state: TuiState, view: ChildPlanView): TuiState {
  return state.child ? { ...state, goal: view.goal ?? state.goal, child: { ...state.child, entry: view.child, reading: false, lost: false } } : state;
}

const heldAbove = (state: TuiState, sessionId: string): boolean => {
  for (let frame = state.child?.parent; frame; frame = frame.child?.parent) {
    if (frame.sessionId === sessionId) return true;
  }
  return false;
};

/** What changes the root under every plan on screen, whichever is viewed. */
const SWITCHES = new Set<Action['type']>(['sessionStarted', 'sessionLoaded', 'sessionCleared', 'sessionDeleted', 'sessionForked']);

/**
 * The plans below the viewed one's parent keep following while it is on screen:
 * what arrives for one of them is reduced on that plan, not dropped as stale,
 * so Esc lands on a plan that is current. `childFailed` stays here: it is the
 * answer to something the viewed plan's person just did.
 */
export function belongsAbove(state: TuiState, action: Action): boolean {
  if (!state.child) return false;
  if (action.type === 'key') return state.overlay !== null;
  if (SWITCHES.has(action.type)) return true;
  if (action.type === 'childTree' || action.type === 'childrenListed' || action.type === 'childFailed') return false;
  const { sessionId } = action as { sessionId?: unknown };
  return typeof sessionId === 'string' && sessionId !== state.sessionId && heldAbove(state, sessionId);
}

/** Runs a step on the plan above the viewed one. If that plan leaves the screen, so does this one. */
export function onParent(state: TuiState, act: (parent: TuiState) => Step): Step {
  if (!state.child || !state.sessionId) return step(state);
  const { parent } = state.child;
  const out = act({ ...parent, ...shared(state) });
  if (out.state.sessionId !== parent.sessionId) {
    // Another session is another conversation; a plan going from under the person leaves their words theirs.
    const left = rootId(out.state) === rootId(state) ? carried(out.state, state.editor.text) : out.state;
    return { state: left, effects: [...out.effects, { type: 'closeChild', childId: state.sessionId }] };
  }
  return { state: { ...state, ...shared(out.state), child: { ...state.child, parent: out.state } }, effects: out.effects };
}

function rawQuestion(tasks: readonly RunTask[], taskId: string): string | undefined {
  for (const task of tasks) {
    const found = task.id === taskId ? task.checkpoint : rawQuestion(task.subtasks, taskId);
    if (found) return found;
  }
  return undefined;
}

/** `words`: what the person typed for an action refused here, which goes back to them with the `note`. */
type Routed = { effects: Effect[]; note?: string; words?: string };

/**
 * Where one effect of a child's frame goes. A child's id on a root route would
 * make the client adopt it as a session of its own, so nothing passes that is
 * not named here: an action this list does not know is refused, out loud.
 */
function routed(frame: TuiState, effect: Effect): Routed {
  const childId = frame.sessionId;
  if (!childId || !('sessionId' in effect) || effect.sessionId !== childId) return { effects: [effect] };
  const root = rootId(frame);
  switch (effect.type) {
    case 'sendMessage':
      return { effects: [{ type: 'messageChild', rootId: root, childId, text: effect.message }] };
    case 'openTaskLog':
    case 'loadTaskAttempt':
      return { effects: [{ ...effect, rootId: root }] };
    case 'sendTaskMessage':
      return { effects: [{ type: 'messageChildTask', rootId: root, childId, taskId: effect.taskId, text: effect.text }] };
    case 'answerTaskCheckpoint': {
      const words = answerWords(effect);
      if (effect.raiseTokens !== undefined) return { effects: [], note: RAISE_ABOVE, words };
      // The daemon compares it exactly, so it is the run's own word, not the row's cleaned one.
      const question = rawQuestion(frame.run.tasks, effect.taskId);
      if (!question) return { effects: [{ type: 'readChild', rootId: root, childId }], note: QUESTION_MOVED, words };
      const { taskId, answer, reason } = effect;
      return { effects: [{ type: 'answerChildCheckpoint', rootId: root, childId, taskId, answer, question, ...(reason ? { reason } : {}) }] };
    }
    case 'stopExecution':
      return { effects: [{ ...effect, sessionId: root }], note: STOPS_THE_RUN };
    case 'reconcileTurn':
      return { effects: [{ type: 'readChild', rootId: root, childId }] };
    case 'saveSettings':
    case 'loadScope':
    case 'refresh':
      return { effects: [{ ...effect, sessionId: root }] };
    default:
      return { effects: [], note: NO_ROUTE };
  }
}

/**
 * Routes by the frame that emitted the effects, which an open or a pop may just
 * have replaced. Only a key's refusal is spoken: the stream's own housekeeping
 * has no person waiting on it.
 */
export function routeChild(before: TuiState, action: Action, result: Step): Step {
  if (!before.child) return result;
  const routes = result.effects.map((effect) => routed(before, effect));
  return {
    state: action.type === 'key' ? routes.reduce((state, { note, words }) => (note ? refused(state, note, words) : state), result.state) : result.state,
    effects: routes.flatMap((route) => route.effects),
  };
}

/**
 * The subplanner's question is its delegated task's, so it is answered on the
 * plan that holds that task: the root's route at depth one, a child's below,
 * where no raise exists to offer.
 */
function answerAbove(state: TuiState, answer: 'approve' | 'reject', reason: string, raiseTokens?: number): Step {
  const asked = questionAbove(state);
  if (!state.child || !asked) return step(state);
  const above = { ...state.child.parent, ...shared(state) };
  const asking: Action = { type: 'key', key: { name: 'enter' } };
  const { effects } = answerCheckpoint(above, above.sessionId ?? '', asked.task.id, answer, reason, raiseTokens);
  // Routed as the plan that holds the task, and a refusal said on the plan the person is reading.
  return routeChild(above, asking, { effects: effects.map((effect) => (effect.type === 'answerTaskCheckpoint' ? { ...effect, below: true } : effect)), state });
}

const emptied = (state: TuiState): TuiState => ({ ...state, editor: { ...state.editor, text: '', cursor: 0 } });

/** ctrl-y and ctrl-g on the question above, spoken for as a task view's are. */
function answerKey(state: TuiState, key: Key): Step | null {
  if (state.taskView || !questionAbove(state)) return null;
  const draft = state.editor.text.trim();
  if (key.name === 'ctrl-g') return answerAbove(draft ? emptied(state) : state, 'reject', draft);
  if (key.name !== 'ctrl-y') return null;
  const raiseTokens = state.child?.parent.child ? undefined : parseCount(draft, 1) ?? undefined;
  return answerAbove(raiseTokens === undefined ? state : emptied(state), 'approve', '', raiseTokens);
}

const PLAN_LETTERS = new Set(['?', 'S', 'l']);
const NO_ROUTE_KEYS = new Set<Key['name']>(['ctrl-s', 'ctrl-x', 'ctrl-r', 'ctrl-t']);
const ATTEMPT_KEYS = new Set<Key['name']>(['alt-left', 'alt-right']);

/**
 * A key the viewed child takes differently from a root: its plan is read here,
 * not edited, an ended one takes nothing but reading, and a task's force and
 * interrupt keys have no route. Null lets the key on to what it does anywhere.
 */
export function childKey(state: TuiState, key: Key): Step | null {
  if (!state.child) return null;
  if (state.focus === 'plan') {
    return key.name === 'char' && !PLAN_LETTERS.has(key.char ?? '') ? step(reportError(state, BELONGS_ABOVE)) : null;
  }
  if (!viewOnly(state)) {
    if (state.taskView && NO_ROUTE_KEYS.has(key.name)) return step(reportError(state, NO_ROUTE));
    return answerKey(state, key);
  }
  if (state.taskView && ATTEMPT_KEYS.has(key.name)) return null;
  const scroll = scrollDelta(key, state, 'chat');
  if (scroll !== null) return scrollChat(state, scroll);
  return key.name === 'enter' || key.name === 'char' ? step(reportError(state, VIEW_ONLY)) : step(state);
}

/** The composer of a viewed child: it answers the question above first, and otherwise speaks to the subplanner. */
export function speakToChild(state: TuiState, cleared: TuiState, text: string): Step {
  if (questionAbove(state)) return answerAbove(cleared, 'approve', text);
  if (!state.sessionId) return step(state);
  return step(say(cleared, 'user', text), [{ type: 'sendMessage', sessionId: state.sessionId, message: text }]);
}

/** Whether a built-in command means anything on a plan below the root. */
export function commandInChild(state: TuiState, name: string): Step | null {
  if (!state.child || !state.sessionId) return null;
  // Not `stopPlanning`: a subplanner's turn is not this surface's to cancel, and the run's stop reaches it.
  if (name === 'stop') return step(state, [{ type: 'stopExecution', sessionId: state.sessionId }]);
  return COMMANDS_HERE.has(name) ? null : step(reportError(state, `/${name} acts on a whole session: Esc goes back to the root to run it.`));
}

/** The daemon's word on a message, which the stream only says when the subplanner reads it. */
export function childMessaged(state: TuiState, status: 'woken' | 'queued'): TuiState {
  return status === 'queued' ? say(state, 'system', 'The subplanner is busy: it reads this after its current turn.') : state;
}

function givenBack(state: TuiState, text: string | undefined): TuiState {
  if (!text) return state;
  const draft = aheadOfDraft(text, state.editor.text);
  return { ...state, editor: { ...state.editor, text: draft, cursor: draft.length } };
}

/** Words the person did not leave behind, on a plan they were moved to. Where no composer shows them, they are told where they are. */
function carried(state: TuiState, text: string): TuiState {
  const back = givenBack(state, text);
  return text && viewOnly(back) ? reportError(back, WORDS_KEPT) : back;
}

/** A refusal, and the words it sends back. Where no composer shows them, the person is told where they are. */
function refused(state: TuiState, message: string, text: string | undefined): TuiState {
  const back = givenBack(state, text);
  return reportError(back, back.editor.text && viewOnly(back) ? `${message} ${WORDS_KEPT}` : message);
}

function endedRow(state: TuiState): TuiState {
  return state.child ? { ...state, child: { ...state.child, entry: { ...state.child.entry, state: 'ended' } } } : state;
}

/** Never `executionLost`'s advice: a child is not loaded, its socket is what comes back. Any read under way went with it. */
export function childLost(state: TuiState): TuiState {
  if (!state.child || state.child.lost) return state;
  return say({ ...state, child: { ...state.child, reading: false, lost: true } }, 'system', 'Lost the connection to this plan; reconnecting.');
}

/** Leaves a plan the daemon no longer serves, saying so on the plan it lands on. A draft it held was not given up: `leaveChild` carries only an ended plan's. */
export function childGone(state: TuiState, message: string, text?: string): Step {
  const left = leaveChild(state);
  return { ...left, state: refused(viewOnly(state) ? left.state : givenBack(left.state, state.editor.text), message, text) };
}

/**
 * A child route's refusal. An answer on the plan above comes back here too,
 * with that plan's id, and is shown where it was given. The person's words
 * land wherever the person is now, whatever became of the plan they were for.
 */
export function childFailed(state: TuiState, action: { sessionId: string; message: string; code?: DaemonErrorCode; text?: string }): Step {
  const { sessionId, message, code, text } = action;
  // No child route reads a root, and its own stream says what moved on it.
  const reread = (childId: string): Effect[] => (code === 'checkpoint_not_waiting' && childId !== rootId(state) ? [{ type: 'readChild', rootId: rootId(state), childId }] : []);
  if (stale(state, sessionId)) return step(refused(state, message, text), heldAbove(state, sessionId) ? reread(sessionId) : []);
  if (code === 'child_not_found') return childGone(state, message, text);
  if (code === 'checkpoint_not_waiting') return step(refused(state, message, text), reread(sessionId));
  return step(refused(code === 'child_view_only' ? endedRow(state) : state, message, text));
}
