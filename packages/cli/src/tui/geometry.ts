import type { TuiState } from './state';

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

/** Below this the plan pane is not worth showing, and neither is the chat beside it. */
export const PLAN_MIN_COLS = 32;
export const PLAN_MAX_COLS = 64;

/** Indent of every labelled block inside the plan pane (Prompt, Description, Depends on). */
const PANE_INDENT = 4;

/** Prompt glyph, plus one column for the caret the frame paints itself. */
const CHAT_PROMPT_COLS = 2;

/** The plan pane appears once there is a plan, and only if it would not crowd the chat. */
export function planPaneWidth(state: TuiState): number {
  if (state.tasks.length === 0) return 0;
  const wanted = Math.min(PLAN_MAX_COLS, Math.floor(state.cols * 0.46));
  return wanted >= PLAN_MIN_COLS && state.cols - wanted > PLAN_MIN_COLS ? wanted : 0;
}

/** What the chat pane gets: the terminal, less the plan pane and the divider between them. */
export function chatPaneWidth(state: TuiState): number {
  const plan = planPaneWidth(state);
  return plan === 0 ? state.cols : state.cols - plan - 1;
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
