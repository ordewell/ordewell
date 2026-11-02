import { width } from './ansi';
import { continuesTask, findTask, resumesTask, type Focus, type TuiState } from './state';

/**
 * Where the TUI's panes are and how wide the things inside them are.
 *
 * The reducer and the renderer both need these numbers — the renderer to paint,
 * the reducer to move a caret through wrapped text — and for a while they each
 * carried their own copy. The copies drifted:
 * the reducer wrapped an expanded task's prompt at the full terminal width while
 * the renderer wrapped it inside the plan pane, so `up` moved the caret to a
 * position computed for a line twice as wide as the one on screen.
 *
 * Nothing here touches state or emits anything. It is arithmetic over
 * `(rows, cols, tasks, taskEditor)`, which is what lets both callers ask instead
 * of assume.
 */

/** Below this the plan pane is not worth showing beside the chat, and neither is the chat beside it. */
export const PLAN_MIN_COLS = 32;
export const PLAN_MAX_COLS = 64;

/** Indent of every labelled block inside the plan pane (Prompt, Description, Depends on). */
const PANE_INDENT = 4;

/** Prompt glyph, plus one column for the caret the frame paints itself. */
const CHAT_PROMPT_COLS = 2;

/**
 * A pane's place on the screen: 1-based and inclusive, the same coordinates a
 * mouse report carries, so a pointer is "in" a pane exactly when it is in the
 * rectangle.
 */
export interface PaneRect {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

/**
 * How the body is divided. With no plan the chat has all of it; with one, the
 * plan sits beside the chat while the terminal is wide enough for both, and
 * under it — at the full width, above the composer — once it is not.
 */
export type BodyMode = 'chat' | 'side' | 'stacked';

/** The plan pane's width beside the chat, or 0 where the two would not both fit. */
function sidePlanWidth(cols: number): number {
  const wanted = Math.min(PLAN_MAX_COLS, Math.floor(cols * 0.46));
  return wanted >= PLAN_MIN_COLS && cols - wanted > PLAN_MIN_COLS ? wanted : 0;
}

export function bodyMode(state: TuiState): BodyMode {
  if (state.tasks.length === 0) return 'chat';
  return sidePlanWidth(state.cols) > 0 ? 'side' : 'stacked';
}

/** How wide the plan pane is: 0 when there is no plan, the terminal when it is stacked. */
export function planPaneWidth(state: TuiState): number {
  const mode = bodyMode(state);
  return mode === 'chat' ? 0 : mode === 'side' ? sidePlanWidth(state.cols) : state.cols;
}

/** What the chat pane gets: the terminal, less the plan pane and the divider between them when they are side by side. */
export function chatPaneWidth(state: TuiState): number {
  return bodyMode(state) === 'side' ? state.cols - sidePlanWidth(state.cols) - 1 : state.cols;
}

/** What the stacked split has to know about each pane's content, in rows. */
export interface StackNeeds {
  /** Rows the chat would fill if nothing limited it. */
  chat: number;
  /** Fewest rows the chat is still usable at (its pinned header, a couple of transcript lines). */
  chatMin: number;
  plan: number;
  planMin: number;
}

/**
 * Divides `body` rows between a stacked chat and plan.
 *
 * Each gets what its content needs while both fit. Under contention they split
 * evenly — the chat taking the odd row — but a pane that needs less than its
 * half gives the rest to the other, so a three-task plan does not sit in half a
 * screen of blanks and a one-line transcript does not either. Neither goes under
 * its minimum.
 *
 * Where the body cannot hold both minimums the focused pane wins: the other
 * shrinks to one row (the plan's header, or the chat's last line) and then to
 * nothing, so the pane the keys are going to is never the one that vanished.
 */
export function stackRows(body: number, needs: StackNeeds, focus: Focus): { chat: number; plan: number } {
  if (body <= 0) return { chat: 0, plan: 0 };
  const chatMin = Math.min(needs.chat, needs.chatMin);
  const planMin = Math.min(needs.plan, needs.planMin);

  if (body < chatMin + planMin) {
    const other = Math.min(1, body - 1);
    return focus === 'plan' ? { chat: other, plan: body - other } : { chat: body - other, plan: other };
  }

  const half = Math.floor(body / 2);
  let plan: number;
  if (needs.chat + needs.plan <= body || needs.plan <= half) plan = needs.plan;
  else if (needs.chat <= body - half) plan = body - needs.chat;
  else plan = half;
  plan = Math.max(planMin, Math.min(plan, body - chatMin));
  return { chat: body - plan, plan };
}

/** Text width inside a labelled block of the plan pane, given that pane's width. */
export function paneTextRoom(paneCols: number): number {
  return Math.max(1, paneCols - PANE_INDENT);
}

/**
 * Wrap width of the expanded task's prompt editor. Derived from the plan pane,
 * never from the terminal — the editor lives inside the pane.
 */
export function taskEditorRoom(state: TuiState): number {
  return paneTextRoom(planPaneWidth(state));
}

/**
 * Wrap width of the chat input, which spans the full terminal regardless of the
 * plan pane. A blurred editor reclaims the caret column because it paints none.
 */
export function chatEditorRoom(cols: number, active: boolean): number {
  return Math.max(1, cols - CHAT_PROMPT_COLS - (active ? 1 : 0));
}

/**
 * The composer's prompt: `→ Task N` in the task view — `→ Continue task N`
 * once the task finished and can be continued, `→ Resume task N` while it is
 * paused on a usage limit — and the bare caret otherwise.
 */
export function chatPromptLabel(state: TuiState): string {
  if (!state.taskView) return '❯';
  const task = findTask(state.tasks, state.taskView.taskId);
  // A Continue is given from the root: below it, a task takes messages or nothing.
  const verb = state.child || !continuesTask(task) ? 'Task' : resumesTask(task) ? 'Resume task' : 'Continue task';
  return `→ ${verb} ${task?.order ?? '?'}`;
}

/**
 * The room the composer has once its own prompt is paid for. The task view's
 * `→ Task N` label is wider than the planner's caret, so wrapping that assumed
 * the two were equal spilled the draft past the pane's right edge.
 */
export function chatEditorRoomFor(state: TuiState, active: boolean): number {
  return Math.max(1, state.cols - width(chatPromptLabel(state)) - 1 - (active ? 1 : 0));
}
