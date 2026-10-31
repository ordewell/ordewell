import { taskServedModel } from './accountLimits';
import { firstGrapheme, nextBoundary, pad, previousBoundary, sanitize, style, truncate, width, wrap, wrapLines, type WrapLine } from './ansi';
import { cursorInLines, type CursorPosition } from './editor';
import { assignmentFlagText, checkpointCardLines, conversationLines, tokenLine } from './blocks';
import { bodyMode, chatEditorRoomFor, chatPaneWidth, planPaneWidth, stackRows, type BodyMode, type PaneRect } from './geometry';
import { slashCommandTable, type SlashCategory } from './slash';
import { continuesTask, findTask, isTaskRunning, planPaneOpen, planRows, plannerInFlight, queuedTarget, refFor, scriptTaskView, selectedPlanRow, signedOutWithLogin, waitingApproval, waitingCheckpoint, type ApprovalRequestView, type Focus, type ModelView, type PlanRow, type TaskView, type TuiState } from './state';
import { SUPERVISOR_LEVEL_LABEL, type DiscoveredModel } from '@ordewell/core';
import { modesForTask } from './taskAssignment';
import { DEFAULT_EFFORT, plannerEffortItems } from './reducers/pickers';
import { cliVersion } from '../version';
import { runnerNamesOr } from '../runnerNames';
import { TASK_EDITOR_KEYS, planFooterHints, planKeysByGroup } from './planKeys';
import { accountLimitsText, attachingLabel, contextMeterText, accountLimitsOf, assignedRunnerOf, describeIsolationPreview, elapsedSince, scriptTaskText, getProviderMeta, isApiProvider, blockedByLabel, handoffPeekParts, holdLabel, skippedLabel, hasHiddenDetail, loopRowParts, resumeTime, runnerForProvider, taskLogHeaderView, taskActivity, taskRowView, taskStatusKind, tasksTotalText, type ApprovalBlock, type DisplayBlock, type QueuedTaskMessage, type TaskLogHeaderTask, type TaskLogHeaderView, type TaskRowLoop, type LoopCheckState, type TaskStatusKind } from '@ordewell/core';

/**
 * What each pane's content actually is, and therefore how far it can scroll.
 *
 * `geometry.ts` exists because the reducer and the renderer both needed the
 * pane *widths* and their copies drifted. The same thing happened one level up:
 * the renderer clamped scrolling to the lines it had just built, while the
 * reducer grew the offset against an estimate — or against no bound at all — so
 * every notch past the real end was absorbed silently and the pane read as
 * frozen until the offset fell back under the bound.
 *
 * The line counts live here so both callers ask the same question. `render.ts`
 * keeps the chrome, the fitting, the pane join and the painting; the reducer
 * imports only the bounds. Nothing here touches state or emits anything.
 */

/** The status row — the one row of chrome the composer and footer do not account for. */
const CHROME_ROWS = 1;

// ── Chrome extents ───────────────────────────────────────────────────────────

/**
 * The most draft text the composer wraps and paints around the caret. The
 * transcript caps a block at 32KB for the same reason, but the composer is
 * repainted on every keystroke and `wrapLines` cannot cache a draft that
 * changes, so its cap is smaller. The window follows the caret rather than
 * showing the head: a pasted log leaves the caret at its end, and typing there
 * must not happen off screen.
 */
const COMPOSER_WINDOW_CHARS = 8 * 1024;

/** The empty rows the composer carries above and below its text, on the grey band. */
export const COMPOSER_BAND_ROWS = 2;

/** The part of the draft the composer actually wraps, paints and reports hiding. */
export interface ComposerView {
  /** The shown slice of the draft. */
  text: string;
  /** Where `text` starts in the draft. */
  base: number;
  /** Wrapped lines of `text`; their `start` offsets are relative to `text`. */
  lines: WrapLine[];
  hiddenBefore: number;
  hiddenAfter: number;
}

/**
 * The chat input's visible window — the wrapped lines around the caret that
 * the composer paints — or `null` when the editor is blurred and therefore
 * always exactly one row (a literal newline would otherwise push every row
 * below it down one line).
 */
export function composerView(state: TuiState): ComposerView | null {
  const active = state.focus === 'chat' && !state.overlay;
  // A script's log is output only (ADR-0035): there is no composer to draw.
  if (!active || scriptTaskView(state)) return null;

  const { text, cursor } = state.editor;
  const room = chatEditorRoomFor(state, true);
  const start = text.length <= COMPOSER_WINDOW_CHARS
    ? 0
    : Math.max(0, Math.min(text.length - COMPOSER_WINDOW_CHARS, cursor - Math.floor(COMPOSER_WINDOW_CHARS / 2)));
  // Back up to the start of a grapheme rather than cutting a joined cluster.
  const before = previousBoundary(text, start);
  const windowBase = nextBoundary(text, before) > start ? before : start;
  const shown = text.slice(windowBase, windowBase + COMPOSER_WINDOW_CHARS);
  const all = wrapLines(shown, room);
  const cursorLine = cursorInLines(all, Math.max(0, cursor - windowBase), shown.length).line;
  // A short terminal keeps half its rows for the transcript and chrome: the
  // caret's own line is always inside this window, so typing stays visible.
  const cap = Math.max(1, Math.min(all.length, Math.floor(state.rows / 2) - COMPOSER_BAND_ROWS));
  const from = Math.max(0, Math.min(all.length - cap, cursorLine - Math.floor(cap / 2)));
  const first = all[from].start;
  const end = from + cap < all.length ? all[from + cap].start : shown.length;
  const visible = shown.slice(first, end);
  return {
    text: visible,
    base: windowBase + first,
    lines: all.slice(from, from + cap).map((line) => ({ ...line, start: line.start - first })),
    hiddenBefore: windowBase + first,
    hiddenAfter: text.length - (windowBase + end),
  };
}

/**
 * Every row the composer takes: its text rows plus the band rows around them.
 * The renderer paints this many and `bodyRows` reserves this many, which is
 * what keeps the frame at exactly `state.rows` lines.
 */
export function composerRows(state: TuiState): number {
  return (composerView(state)?.lines.length ?? 1) + COMPOSER_BAND_ROWS;
}

/**
 * The footer's key hints, unpainted. Kept next to the body extents because the
 * footer's height is what is left over for the body. The plan pane names only
 * the keys that fit the selected task and leaves the rest to the `?` sheet, so
 * it stays one row and the task list keeps the room.
 */
export function footerHints(state: TuiState): string[] {
  const selected = selectedPlanRow(state)?.task;
  // A planning turn in flight owns ESC ahead of whatever the pane would
  // otherwise bind it to. What ESC does there depends on what is waiting: a
  // queued prompt it takes back, otherwise the first press arms the stop and
  // the second commits it — so the hint names the state the key is actually in.
  // The arm itself is not named here: its cue is the status row's red line, and
  // a second one in the footer would say the same thing twice and change the
  // footer's height the moment the arm appeared.
  // The task view owns Esc while it is open, so the planner's turn-queue hint
  // would name a key behaviour that is not in force.
  const planning = plannerInFlight(state) && !state.taskView;
  // Revealed subtask rows keep Esc for themselves, so the planner's hint would be untrue.
  const escHint = !planning || planPaneOpen(state) ? null
    : state.queuedPrompts.length > 0 ? 'esc unsend'
    : 'esc ×2 stop planning';
  // Send now is the composer's key, so it is named only where the composer
  // owns it: the chat pane, with a turn in flight.
  // A task's composer queues its text behind the running step; ctrl-s is the
  // other way to send it, named while there is text it would send.
  const tv = state.taskView;
  const script = scriptTaskView(state);
  const taskSends = !!tv && !script && tv.view.working && !!state.editor.text.trim() && !continuesTask(findTask(state.tasks, tv.taskId));
  const sendNowHint = planning || taskSends ? 'ctrl-s send now' : null;
  const stopRunnerHint = runnerStoppable(state) ? 'ctrl-x stop runner' : null;
  // The same choices the card lists, kept in reach while the question scrolls
  // away. A tool request waiting ahead answers first, and its card says how.
  const checkpointHints = tv && !script && waitingCheckpoint(findTask(state.tasks, tv.taskId)) && !waitingApproval(tv)
    ? ['enter reply', 'ctrl-y approve', 'ctrl-g reject']
    : [];

  if (state.focus === 'plan') {
    // `expandedTaskId` alone only means subtask rows are revealed — the editor
    // hints belong to `taskEditor`, or a browsing parent would claim its keys
    // type into a prompt draft that isn't actually open.
    if (state.taskEditor) {
      return ['type to edit prompt', 'pgup/pgdn scroll', 'alt-enter newline', 'enter save', 'esc cancel'];
    }
    return [...(escHint ? [escHint] : []), ...planFooterHints(selected, state.status === 'executing')];
  }
  // The detail-all toggle names the direction it will go, like `m done` does.
  // Shown only once the conversation holds something it can expand: the
  // welcome alone must keep the footer to one row, or a short terminal
  // gives up a row of the welcome.
  const detailHint = hasHiddenDetail(state.taskView ? state.taskView.view.blocks : state.conversation.blocks)
    ? [state.detailAll ? 'ctrl-o collapse all' : 'ctrl-o expand all']
    : [];
  return [
    '/help',
    ...checkpointHints,
    ...(stopRunnerHint ? [stopRunnerHint] : []),
    'tab plan',
    ...detailHint,
    ...(escHint ? [escHint] : []),
    ...(sendNowHint ? [sendNowHint] : []),
    'ctrl-c quit',
  ];
}

/**
 * The queue's bubbles, one bubble per prompt, in queue order. Not part of the
 * conversation view: a prompt joins it only once it is sent. Esc and ctrl-s
 * take the newest, so only its row names them; ctrl-s takes the composer's
 * text instead while there is any.
 */
export function queuedPromptRows(state: TuiState, cols: number): string[] {
  const newest = state.queuedPrompts.length - 1;
  const keys = [' · esc to unsend', ...(state.editor.text.trim() ? [] : [' · ctrl-s sends now'])];
  return state.queuedPrompts.flatMap((text, i) => queuedBubble(text, i === newest ? [' · queued', ...keys] : [' · queued'], cols));
}

/** The columns a queued row's marker (or its continuation indent) takes before the text. */
const MARKER_LEAD = 2;

/** Fewer columns than this left after the text cannot say what a hint is, so none is drawn. */
const MIN_HINT_COLS = 10;

/** Columns of text a row keeps before its hint is given up rather than squeeze the text. */
const MIN_TEXT_COLS = 12;

/**
 * A queued row's hint: as many of its parts (the state first, then each key)
 * as fit whole in the columns its text left, else the state cut to them.
 * Never the text that gives way.
 */
function hintAfter(text: string, parts: string[], cols: number): string {
  const left = cols - width(text);
  if (left < MIN_HINT_COLS) return '';
  for (let n = parts.length; n > 0; n--) {
    const tag = parts.slice(0, n).join('');
    if (width(tag) <= left) return tag;
  }
  return truncate(parts[0] ?? '', left);
}

/**
 * The columns to wrap a queued message's text to under a marker of `lead`
 * columns. The hint is reserved only while it leaves room to read the text:
 * the keys go first, then the state, and a narrow pane still wraps under the
 * marker's own two columns — or every full-width row would lose its tail to
 * `truncate`.
 */
function queuedRoom(lead: string, parts: string[], cols: number): number {
  for (const tag of [parts.join(''), parts[0] ?? '']) {
    if (cols - width(`${lead}${tag}`) >= MIN_TEXT_COLS) return cols - width(`${lead}${tag}`);
  }
  return Math.max(1, cols - MARKER_LEAD);
}

/** One queued prompt wrapped under a dimmed marker, its hint on its first row. */
function queuedBubble(text: string, parts: string[], cols: number): string[] {
  return wrap(text, queuedRoom('◇  ', parts, cols)).map((line, i) => i === 0
    ? `${style.grey(`◇ ${line}`)}${hintAfter(`◇ ${line}`, parts, cols)}`
    : truncate(style.grey(`  ${line}`), cols));
}

/**
 * The task view's pending messages, one bubble each, in queue order, each
 * with its state (ADR-0023): queued — not with the runner yet, removable;
 * waiting for the current step — handed over, the runner reads it at its next
 * step; sending now — forced, until it is delivered. The message the keys act
 * on is highlighted and carries them: ctrl-s with the composer empty (it sends
 * the composer's text otherwise), ctrl-r while it can still be removed.
 */
export function taskQueuedRows(state: TuiState, cols: number): string[] {
  const tv = state.taskView;
  if (!tv) return [];
  const target = queuedTarget(tv);
  const sends = !state.editor.text.trim();
  return tv.view.queued.flatMap((message, i) => queuedTaskBubble(message, i === target, sends, cols));
}

function queuedTaskParts({ handedOver, forced }: QueuedTaskMessage, target: boolean, sends: boolean): string[] {
  if (forced) return [' · sending now…'];
  const sendNow = target && sends ? [' · ctrl-s sends now'] : [];
  if (handedOver) return [' · waiting for the current step', ...sendNow];
  return [' · queued', ...sendNow, ...(target ? [' · ctrl-r removes'] : [])];
}

function queuedTaskBubble(message: QueuedTaskMessage, target: boolean, sends: boolean, cols: number): string[] {
  const { text } = message;
  const marker = target ? style.accent('❯') : style.grey('◇');
  const parts = queuedTaskParts(message, target, sends);
  return wrap(text, queuedRoom('❯ ◇  ', parts, cols)).map((line, i) => i === 0
    ? `${marker} ${target ? style.bold(line) : line}${style.grey(hintAfter(`◇ ${line}`, parts, cols))}`
    : truncate(`  ${line}`, cols));
}

/** Every status kind's word in a plan row, sentence case. */
const STATUS_WORD: Record<TaskStatusKind, string> = {
  done: 'Done',
  failed: 'Failed',
  running: 'Running',
  quiet: 'Stalled',
  awaiting: 'Awaiting',
  blocked: 'Blocked',
  skipped: 'Skipped',
  todo: 'To do',
};

/**
 * The task as the opened log's header reads it: the store's facts plus the
 * silence only this surface tracks. The daemon's count of runner requests
 * waiting for an answer is passed beside it.
 */
function logHeaderTask(task: TaskView | undefined): TaskLogHeaderTask {
  return {
    status: task?.status ?? '',
    ...(task?.awaitingReason ? { awaitingReason: task.awaitingReason } : {}),
    ...(task?.skipReason !== undefined ? { skipReason: task.skipReason } : {}),
    resumeAt: task?.resumeAt ?? null,
    idleSince: task?.idleSince ?? null,
    continuable: task?.continuable === true,
    ...(task?.isolation?.state === 'conflict' && task.isolation.repairWaits ? { repairWaits: task.isolation.repairWaits } : {}),
    attemptUsage: task?.attemptUsage ?? [],
  };
}

/** What core says the opened task's log header shows: one reading for both surfaces (ADR-0018, V1). */
function logHeader(state: TuiState, tv: NonNullable<TuiState['taskView']>): TaskLogHeaderView {
  const task = findTask(state.tasks, tv.taskId);
  return taskLogHeaderView(logHeaderTask(task), tv, task?.awaitingApproval ?? 0, tv.attempt);
}

/** The task view's two pinned rows: the accent bar, and the keys it owns. */
function taskHeaderLines(state: TuiState, tv: NonNullable<TuiState['taskView']>, cols: number): string[] {
  const task = findTask(state.tasks, tv.taskId);
  const header = logHeader(state, tv);
  const parts = [
    `→ Task ${task ? refFor(state, task).slice(1) : '?'}`,
    task?.title ?? '(task removed)',
    (task && assignedRunnerOf(task)) ?? '',
    task ? inRow(header.state.label) : '',
    header.resumes ? inRow(header.resumes) : '',
  ].filter(Boolean);
  const approval = waitingApproval(tv);
  // A script's log is read-only output (ADR-0035): no runner, queue or send keys.
  const hint = scriptTaskView(state)
    ? ['read-only output', 'esc back']
    : approval
      ? ['ctrl-y allow', ...(approval.allowForTask ? ['ctrl-t allow for task'] : []), 'ctrl-g deny (composer text is the note)']
      : waitingCheckpoint(task)
        ? ['enter reply', 'ctrl-y approve', 'ctrl-g reject', 'ctrl-x stop runner']
        : header.resumes
          ? ['ctrl-x don\'t resume']
          : [...(runnerStoppable(state) ? ['ctrl-x stop runner'] : []), 'ctrl-r remove queued', 'ctrl-s send now'];
  if (approval && waitingCheckpoint(task)) hint.push('then the checkpoint');
  const index = tv.attempts.indexOf(tv.attempt);
  if (tv.attempts.length > 1) hint.push(`alt←/→ attempt ${index >= 0 ? index + 1 : 1}/${tv.attempts.length}`);
  hint.push('esc back');
  return [
    style.accent(truncate(parts.join(' · '), cols)),
    tv.notice ? style.red(truncate(tv.notice, cols)) : style.grey(truncate(hint.join(' · '), cols)),
  ];
}

/**
 * The standing arm of the in-flight turn's stop. Painted red at the paint site
 * and shown on the status row — always exactly one line, so appearing and
 * expiring never changes the body's height the way a footer hint would.
 */
export function stopHint(state: TuiState): string {
  return plannerInFlight(state) && state.stopArmed ? 'Press Esc again to stop' : '';
}

/** The frame counter wraps at a multiple of the spinner's ten frames, so the animation skips no beat at the wrap. */
export const SPINNER_CYCLE = 40;

/**
 * Whether ctrl-x in the open task view stops a runner that is working: the
 * `Working…` condition, minus a runner request waiting for an answer, which
 * has its own keys. A paused or finished task has no turn to stop.
 */
export function runnerStoppable(state: TuiState): boolean {
  const tv = state.taskView;
  const activity = chatActivity(state);
  // A quiet runner is still a live one: stopping it is what its row is for.
  if (!tv || !(activity?.busy || activity?.quiet)) return false;
  // A script runs no model: there is no turn to interrupt (ADR-0035).
  if (scriptTaskView(state)) return false;
  const task = findTask(state.tasks, tv.taskId);
  return !task?.awaitingApproval && !waitingApproval(tv);
}

/** What the status row says about the selected chat: `busy` is the one that animates. */
export interface ChatActivity {
  label: string;
  busy: boolean;
  /** A running task whose runner has gone quiet: a static marker, not the spinner. */
  quiet?: true;
  /** When the turn behind the label began (ISO), for the time at the end of the line; none when its log did not say (#81). */
  since?: string;
}

/** Whether a spinner on screen moves with the tick: a running task's plan row, or the status row's. */
export function animating(state: TuiState): boolean {
  return state.tasks.some((t) => taskStatusKind(t) === 'running') || !!chatActivity(state)?.busy;
}

/** The elapsed time the status row would end on at `now`, which a quiet runner's line keeps counting; '' when it has none to show. */
export function activityTime(state: TuiState, now: number): string {
  return elapsedSince(chatActivity(state)?.since, now);
}

/**
 * The status row relates to the chat on screen and to nothing else. What the
 * planner or a runner is doing is already in that chat, so this names only the
 * state of the chat itself — never a tool, never the run. A subtask has no
 * attempt of its own: it runs inside its parent's, so its view follows it.
 */
export function chatActivity(state: TuiState): ChatActivity | null {
  const tv = state.taskView;
  if (!tv) {
    if (state.status === 'starting') return { label: 'Starting the plan…', busy: true };
    if (!plannerInFlight(state)) return null;
    const label = state.planner === 'condensing' ? 'Condensing…' : state.planner === 'compacting' ? 'Compacting…' : state.planner === 'awaiting' ? 'Waiting for the planner…' : 'Planning…';
    // A compaction or a wait for the planner opens no turn of its own.
    const since = state.turnGate.open !== null ? state.turnGate.openedAt : undefined;
    return since ? { label, busy: true, since } : { label, busy: true };
  }
  const own = findTask(state.tasks, tv.taskId);
  const task = state.tasks.find((t) => t.subtasks?.some((s) => s.id === tv.taskId)) ?? own;
  if (!task) return null;
  // Nothing has been sent to a runner whose tools have not connected, so it is not working yet (ADR-0025).
  const attaching = attachingLabel(task);
  if (attaching) return { label: `${attaching}…`, busy: true };
  if (isTaskRunning(task) || (own && isTaskRunning(own))) {
    // A subtask runs inside its parent's attempt, whose facts the row follows.
    const running = isTaskRunning(task) ? task : own;
    // An earlier attempt is browsed, not run: what its log left open ended with it.
    const archived = tv.attempts.length > 0 && tv.attempt < Math.max(...tv.attempts);
    const activity = running && taskActivity({ ...tv.view, archived }, running);
    if (!activity) return null;
    return activity.busy ? activity : { ...activity, quiet: true };
  }
  const at = task.status === 'awaiting_user' && task.awaitingReason === 'usage-limit' && task.resumeAt ? new Date(task.resumeAt) : null;
  if (at && !Number.isNaN(at.getTime())) return { label: `paused · resumes ${resumeTime(at)}`, busy: false };
  return null;
}

/**
 * What the run as a whole is waiting on, longest wording first: the run is not
 * the selected chat's business, but it must stay visible whichever chat is. The
 * plan pane's title takes the longest one that fits its width.
 */
export function runHints(state: TuiState): string[] {
  if (state.status === 'starting') return ['starting…', 'starting'];
  const waiting = state.tasks.filter((t) => t.status === 'awaiting_user').length;
  if (waiting > 0) return [waiting === 1 ? '1 task waits for you' : `${waiting} tasks wait for you`, `${waiting} waiting`];
  // As plain as a task that waits on the user: the run waits on a merge (ADR-0020).
  return state.runMerge?.paused ? ['paused for Merge all: /handoff merge', 'paused · /handoff merge', 'merge paused'] : [];
}

export const runHint = (state: TuiState): string => runHints(state)[0] ?? '';

/** The status row's count of what waits on the person (ADR-0053); nothing while the list is empty. */
export function inboxHint(state: TuiState): string {
  const waiting = state.run.escalations?.length ?? 0;
  return waiting > 0 ? `${waiting} waiting: /inbox` : '';
}

export function packHints(hints: string[], cols: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const hint of hints) {
    const next = current ? `${current} · ${hint}` : hint;
    if (current && next.length > cols) {
      lines.push(current);
      current = hint;
    } else {
      current = next;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Rows the body gets once the chrome has taken its share — the number the
 * renderer fits each pane to, and therefore the number every scroll bound is
 * measured against.
 */
export function bodyRows(state: TuiState): number {
  const footer = packHints(footerHints(state), state.cols).length;
  return Math.max(0, state.rows - CHROME_ROWS - composerRows(state) - footer);
}

// ── Chat body ────────────────────────────────────────────────────────────────

interface ChatBodyMemo {
  blocks: readonly DisplayBlock[];
  cols: number;
  detailAll: boolean;
  lines: string[];
}

// The transcript is the single most expensive thing to render, but a spinner
// tick, a `status_update` flood or the user scrolling the plan pane never
// touch it — and core's conversation view hands back the same `blocks` array
// for anything that changes nothing. Memoising the lines on that reference
// lets those renders skip straight to re-fitting the cached body, which is
// what stops arrow-key scrolling on a task from lagging while a six-task plan
// runs. A single last-seen entry is all that can be reused, which is why the
// reducer asks for its scroll bound at the same width the renderer will paint
// at: the two of them share the one entry instead of evicting each other's.
let chatBodyMemo: ChatBodyMemo | null = null;

export function chatBodyLines(blocks: readonly DisplayBlock[], cols: number, detailAll: boolean, answering?: ApprovalBlock): string[] {
  const memo = chatBodyMemo;
  if (memo && memo.blocks === blocks && memo.cols === cols && memo.detailAll === detailAll) return memo.lines;
  const lines = conversationLines(blocks, cols, detailAll, answering);
  chatBodyMemo = { blocks, cols, detailAll, lines };
  return lines;
}

/**
 * The chat pane's content, the edge it hangs off, and how far back it can be
 * scrolled. `maxScroll` is the whole point: it is the exact number of lines
 * that exist above the viewport, so an offset clamped to it can never sit in a
 * dead zone the renderer will silently ignore.
 */
export interface ChatLayout {
  lines: string[];
  /** Rows pinned above the scrolling lines, which no scrolling moves. Empty for the planner chat. */
  header: string[];
  /** Rows pinned under the scrolling lines, which no scrolling moves. */
  footer: string[];
  anchor: 'top' | 'bottom';
  maxScroll: number;
}

export function chatLayout(state: TuiState, rows: number, cols: number): ChatLayout {
  const tv = state.taskView;
  // The task view draws the runner's own blocks; the planner chat draws the
  // conversation's. Both go through the same core view, so they paint alike.
  const blocks = tv ? tv.view.blocks : state.conversation.blocks;
  // The welcome (logo, setup, hints) heads the transcript for the whole
  // planning conversation and only goes once a plan exists — from then on the
  // plan pane owns the screen and the chat column is too narrow for it.
  const welcome = !tv && state.tasks.length === 0;
  // Not a block of the runner's log, so it stays out of the memoised body.
  const checkpoint = tv ? waitingCheckpoint(findTask(state.tasks, tv.taskId)) : undefined;
  const card = tv && checkpoint ? checkpointCardLines(findTask(state.tasks, tv.taskId)?.order ?? 0, checkpoint, cols, waitingApproval(tv) !== undefined) : [];
  const answering = chatBodyLines(blocks, cols, state.detailAll, tv ? waitingApproval(tv) : undefined);
  const body = card.length > 0 ? [...answering, ...card] : answering;
  const transcript = !welcome ? body : body.length === 0 ? welcomeLines(state, rows, cols) : [...welcomeLines(state, rows, cols), '', ...body];
  // The queued prompts paint as part of the tail, newest last — they are the
  // turns that have not gone out yet, and they travel where a sent message
  // would have appeared. A task's queue is its own, taken back one at a time.
  const bubbles = tv ? taskQueuedRows(state, cols) : queuedPromptRows(state, cols);
  const content = [...transcript, ...(bubbles.length > 0 ? ['', ...bubbles] : [])];
  const taskHeader = tv ? taskHeaderLines(state, tv, cols) : [];
  // The usage rows are the session's (or the opened task's), not lines of the
  // transcript: they keep the pane's bottom rows while everything above them
  // scrolls — unless the pane is a single row, which belongs to the conversation.
  const usage = rows <= 1 ? [] : tv ? taskUsageFooter(state, tv, cols) : [...plannerPauseRow(state, cols), ...plannerResendRow(state, cols), ...tokenRow(state, blocks, cols)];
  // The per-model rows are the expendable part: they yield to the transcript
  // so a short pane never trades its last conversation row for a breakdown.
  const footer = usage.slice(0, Math.max(1, rows - taskHeader.length - 1));
  const space = Math.max(0, rows - taskHeader.length - footer.length);
  // Content that fits hangs off the top so the welcome does not jump when the
  // first message lands; once it overflows the newest lines win the pane.
  return { lines: content, header: taskHeader, footer, anchor: content.length > space ? 'bottom' : 'top', maxScroll: Math.max(0, content.length - space) };
}

/** The planner turn waiting on its usage limit, pinned beside the usage rows so it stays in view as the chat scrolls. */
function plannerResendRow(state: TuiState, cols: number): string[] {
  const { plannerResend } = state;
  const at = plannerResend ? new Date(plannerResend.at) : null;
  if (!plannerResend || !at || Number.isNaN(at.getTime())) return [];
  const whose = plannerResend.runner ? `${plannerResend.runner}'s` : "the planner's";
  return [style.yellow(truncate(`⏸ Resending at ${resumeTime(at)}, once ${whose} usage limit resets · /resend cancel keeps it for your next message`, cols))];
}

/** The planner paused on its context, pinned beside the usage rows; not while a turn runs, which a retry is. */
function plannerPauseRow(state: TuiState, cols: number): string[] {
  const { plannerPause } = state;
  if (!plannerPause || plannerInFlight(state)) return [];
  return [style.yellow(truncate(`⏸ Planner paused: its context does not fit ${plannerPause.model}'s window · /compact retry attempts recovery · /stop drops the turn`, cols))];
}

const tokenRow = (state: TuiState, blocks: readonly DisplayBlock[], cols: number): string[] => {
  const runner = runnerForProvider(state.plannerProvider);
  const limits = accountLimitsOf(state.accountLimits, runner ?? undefined, state.orchestratorModel);
  const line = tokenLine(blocks, cols, limits);
  return line ? [line] : [];
};

/**
 * The opened task's usage, as core's log header words it: its whole spend
 * across every attempt, with the meter of the latest. On a past attempt that
 * attempt's own numbers come first, the task total under them. An attempt with
 * no ledger of its own — a log saved before logs and ledgers shared one number
 * — has the log's own last usage block there instead, and still the task total.
 */
function taskUsageFooter(state: TuiState, tv: NonNullable<TuiState['taskView']>, cols: number): string[] {
  const task = findTask(state.tasks, tv.taskId);
  const limits = accountLimitsOf(state.accountLimits, task && assignedRunnerOf(task), task && taskServedModel(state, task))
    .map(accountLimitsText).filter(Boolean).join(' · ');
  const rows = logHeader(state, tv).usage;
  const text = rows.map((row, index) => {
    if (!limits || index !== rows.length - 1) return row.text;
    const context = contextMeterText(row.contextFill);
    return context ? row.text.replace(context, `${context} · ${limits}`) : `${limits} · ${row.text}`;
  });
  if (text.length === 0 && limits) text.push(limits);
  return text.map((row) => style.grey(truncate(sanitize(row).replace(/\n/g, ' '), cols)));
}

/**
 * Where the body's panes are, measured: the one answer the renderer and every
 * reducer take their sizes from, so a pane is never painted at one height and
 * scrolled at another.
 *
 * Side by side the panes share the body's rows. Stacked they share its columns,
 * and the rows are divided by what each pane has to say — which is why this
 * lives with the content layouts rather than in `geometry.ts`, whose widths need
 * no content. `plan` is `null` only while there is no plan; a stacked plan that
 * the body has no room for is a rect of zero rows.
 */
export interface BodyPanes {
  mode: BodyMode;
  chat: PaneRect;
  plan: PaneRect | null;
}

/** Transcript rows below the task view's pinned header that keep a stacked chat worth looking at. */
const STACKED_CHAT_BODY_MIN = 2;
/** The plan's header, the line under it, and one task row. */
const STACKED_PLAN_MIN = 3;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

export function bodyPanes(state: TuiState): BodyPanes {
  const mode = bodyMode(state);
  const rows = bodyRows(state);
  const chatCols = chatPaneWidth(state);
  if (mode === 'chat') return { mode, chat: { row: 1, col: 1, rows, cols: chatCols }, plan: null };

  const planCols = planPaneWidth(state);
  if (mode === 'side') {
    return { mode, chat: { row: 1, col: 1, rows, cols: chatCols }, plan: { row: 1, col: chatCols + 2, rows, cols: planCols } };
  }

  // Measured with no row limit, so the answer is what each pane would fill, not
  // what it was last handed.
  const chat = chatLayout(state, UNBOUNDED, chatCols);
  const split = stackRows(rows, {
    chat: chat.header.length + chat.lines.length + chat.footer.length,
    chatMin: chat.header.length + STACKED_CHAT_BODY_MIN,
    plan: planLayout(state, UNBOUNDED, planCols).lines.length,
    planMin: STACKED_PLAN_MIN,
  }, state.focus);
  return {
    mode,
    chat: { row: 1, col: 1, rows: split.chat, cols: chatCols },
    plan: { row: 1 + split.chat, col: 1, rows: split.plan, cols: planCols },
  };
}

/** The pane a screen row falls in, or `null` for the chrome under the body. Only a stacked body is split by row. */
export function stackedPaneAtRow(panes: BodyPanes, row: number): Focus | null {
  if (panes.mode !== 'stacked' || !panes.plan) return null;
  if (row >= panes.chat.row && row < panes.chat.row + panes.chat.rows) return 'chat';
  return row >= panes.plan.row && row < panes.plan.row + panes.plan.rows ? 'plan' : null;
}

/**
 * The screen cells a selection pinned to `pane` may cover, inclusive and
 * 1-based: the rows it can span, the columns a body row takes, and the columns
 * a chrome row takes. Side by side the panes share rows, so columns alone keep
 * a copy from splicing them; stacked they share columns, so rows do — a drag
 * out of the transcript stops at its last row instead of picking up the plan's
 * first. With no plan to pin to, a `'plan'` gets the chat's area rather than an
 * empty one.
 */
export interface SelectionArea {
  firstRow: number;
  lastRow: number;
  /** The pane's columns, taken by the rows in `bodyFirstRow`..`bodyLastRow`. */
  firstCol: number;
  lastCol: number;
  /** The rows of the range that are a pane's own body; every other row is chrome. */
  bodyFirstRow: number;
  bodyLastRow: number;
  /** The frame's columns, taken by a chrome row. */
  frameFirstCol: number;
  frameLastCol: number;
}

/**
 * `from` is the row the press landed on, which decides whether the drag is a
 * pane's or the chrome's — the composer, its grey band and the rows below are
 * drawn across the whole frame, so a selection covering them takes every
 * column. Stacked the two never mix: the rows between a pane and the chrome
 * belong to its neighbour.
 */
export function selectionArea(state: TuiState, pane: Focus, from: number, panes: BodyPanes = bodyPanes(state)): SelectionArea {
  const rect = pane === 'plan' && panes.plan ? panes.plan : panes.chat;
  const bodyLast = bodyRows(state);
  const chromeFirst = bodyLast + 1;
  const firstCol = rect.col;
  const lastCol = rect.col + rect.cols - 1;
  if (panes.mode === 'stacked') {
    if (from >= chromeFirst) {
      // A stacked pane's rows are the only ones that may be mixed with its
      // neighbour's, and those of the body are not: the press landed under
      // them, so nothing of either pane is in reach.
      return {
        firstRow: chromeFirst, lastRow: state.rows, firstCol, lastCol,
        bodyFirstRow: chromeFirst, bodyLastRow: bodyLast,
        frameFirstCol: 1, frameLastCol: state.cols,
      };
    }
    const lastPaneRow = Math.max(rect.row, rect.row + rect.rows - 1);
    return {
      firstRow: rect.row, lastRow: lastPaneRow, firstCol, lastCol,
      bodyFirstRow: rect.row, bodyLastRow: lastPaneRow,
      frameFirstCol: 1, frameLastCol: state.cols,
    };
  }
  // Side by side the pane's rows run all the way down, through the chrome: the
  // columns are what keep the two panes apart, so only rows past the body take
  // the whole frame.
  return {
    firstRow: 1, lastRow: state.rows, firstCol, lastCol,
    bodyFirstRow: 1, bodyLastRow: bodyLast,
    frameFirstCol: 1, frameLastCol: state.cols,
  };
}

/** The columns a selected row may take: its pane's, or the whole frame on the chrome. */
export function selectionColumns(area: SelectionArea, row: number): { firstCol: number; lastCol: number } {
  return row >= area.bodyFirstRow && row <= area.bodyLastRow
    ? { firstCol: area.firstCol, lastCol: area.lastCol }
    : { firstCol: area.frameFirstCol, lastCol: area.frameLastCol };
}

/** How far back the chat pane can be scrolled at the size it is about to be painted. */
export function chatScrollMax(state: TuiState): number {
  const { chat } = bodyPanes(state);
  return chatLayout(state, chat.rows, chat.cols).maxScroll;
}

// ── Welcome ──────────────────────────────────────────────────────────────────

/**
 * The planner backend as the welcome should name it, and whether it can
 * actually run: a coding agent needs its CLI installed, a vendor needs a key.
 */
function plannerSetup(state: TuiState): { label: string; ready: boolean } {
  const provider = state.plannerProvider;
  const registration = getProviderMeta(provider);
  if (!registration) return { label: 'not set', ready: false };
  const runner = runnerForProvider(provider);
  const ready = runner
    ? state.runners.some((r) => r.id === runner)
    : isApiProvider(provider) && state.configuredProviders.includes(provider);
  return { label: registration.label, ready };
}

const SETUP_KEY_COLS = 10;
const SETUP_VALUE_COLS = 32;

/** The run settings (ADR-0030), the settings that let Ordewell act unasked drawn as a warning. */
function runSettingsValue(state: TuiState): string {
  // After a switch the previous session's values are not this one's; say
  // nothing rather than paint a guess until its own read lands.
  if (!state.runSettingsKnown) return style.grey('…');
  const { supervisorLevel, mergeAtGatesAutomatically, autorun } = state.runSettings;
  const level = `supervisor ${SUPERVISOR_LEVEL_LABEL[supervisorLevel]}`;
  return [
    supervisorLevel === 'act' ? style.yellow(level) : level,
    `auto-merge ${mergeAtGatesAutomatically ? 'on' : 'off'}`,
    autorun ? style.yellow('autorun on') : 'autorun off',
  ].join(' · ');
}

/** The planner's effort as its picker labels it; empty when none is chosen or the model has no levels. */
function plannerEffortLabel(state: TuiState): string {
  const chosen = plannerEffortItems(state, state.plannerProvider, state.orchestratorModel, state.plannerEffort)
    .find((item) => item.selected && !item.disabled && item.id !== DEFAULT_EFFORT);
  return chosen?.label ?? '';
}

function setupRow(label: string, value: string, command: string, cols: number): string {
  const head = `  ${style.grey(pad(label, SETUP_KEY_COLS))}${value}`;
  if (!command) return truncate(head, cols - 1);
  // Padded rather than truncated to the value column: a long model id keeps its
  // name and pushes the command right, instead of being cut to fit a grid.
  const gap = ' '.repeat(Math.max(2, SETUP_VALUE_COLS - width(value)));
  return truncate(`${head}${gap}${style.grey(command)}`, cols - 1);
}

interface MarkCell { glyph: string; dot: boolean }

/** Dot bits of a braille cell, by [row][column] within its 2×4 grid. */
const BRAILLE_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

/** Each 4-dot band of the grid as one row of braille cells. */
function brailleRows(grid: string[]): MarkCell[][] {
  const bands = Array.from({ length: grid.length / 4 }, (_, b) => grid.slice(b * 4, b * 4 + 4));
  return bands.map((band) => Array.from({ length: Math.ceil(band[0].length / 2) }, (_, cell) => {
    let bits = 0;
    let dot = false;
    band.forEach((line, r) => BRAILLE_BITS[r].forEach((bit, c) => {
      const mark = line[cell * 2 + c];
      if (mark === '#' || mark === 'o') bits |= bit;
      if (mark === 'o') dot = true;
    }));
    return { glyph: String.fromCodePoint(0x2800 + bits), dot };
  }));
}

/** Painted per frame, not at load: colour is only switched on or off once the terminal starts. */
const paintMark = (row: MarkCell[]): string => row.map(({ glyph, dot }) => dot ? style.brand(glyph) : glyph).join('');

const VERSION = cliVersion();

/** The version rides on the workspace row rather than costing the welcome a row of its own. */
function workspaceLine(workspace: string, cols: number): string {
  const versioned = VERSION === 'unknown' ? workspace : `${workspace} · v${VERSION}`;
  return style.grey(width(versioned) <= cols - 1 ? versioned : workspace);
}

/**
 * The full logo's icon, for a pane with room for it, on a braille dot grid:
 * strokes two dots thick that leave level and ease into
 * the trunk, which runs flush into the dot. The dot starts on a cell boundary
 * and fills its cells alone — a braille cell takes one colour, so a cell that
 * held both trunk and dot would paint one of them the other's colour. Its rows
 * run 4, 6, 8, 8 dots wide to read round. Only the top half is drawn.
 */
const BANNER_ICON_TOP_HALF = [
  '####..............................',
  '######............................',
  '....####..........................',
  '......###.........................',
  '.......####.......................',
  '.........###......................',
  '..........####....................',
  '............###...................',
  '.............###............oooo..',
  '..............####.........oooooo.',
  '................######....oooooooo',
  '##########################oooooooo',
];

const BANNER_ICON = brailleRows([...BANNER_ICON_TOP_HALF, ...[...BANNER_ICON_TOP_HALF].reverse()]);

/** The lowercase wordmark traced into braille cells, one string per icon row. */
const BANNER_WORD = [
  '                   ⢸⣿⡇                            ⢸⣿  ⣿⣿',
  ' ⣀⣤⣤⣤⣤⡀  ⣤⣤⢀⣤⡄ ⣀⣤⣤⣤⣸⣿⡇  ⣠⣤⣤⣤⣀ ⢠⣤⡄  ⣤⣤  ⣠⣤  ⣠⣤⣤⣤⣀  ⢸⣿  ⣿⣿',
  '⣰⣿⠏⠁⠈⢻⣿⡆ ⣿⣿⠟⠉⠁⣰⣿⠏⠉⠉⢻⣿⡇ ⣾⡟⠁ ⠙⣿⡆ ⣿⣧ ⢸⡿⣿⡄ ⣿⡏ ⣾⡿⠁ ⠙⣿⣆ ⢸⣿  ⣿⣿',
  '⣿⣿    ⣿⡇ ⣿⣿   ⣿⣿   ⢸⣿⡇⢸⣿⡿⠿⠿⠿⠿⠟ ⢸⣿⡀⣿⠇⢹⣇⢸⣿⠁ ⣿⡿⠿⠿⠿⠿⠿ ⢸⣿  ⣿⣿',
  '⠹⣿⣦⣀⣀⣼⣿⠃ ⣿⣿   ⠸⣿⣦⣀⣠⣾⣿⡇ ⢿⣷⣀⣀⣠⣶⠆  ⢿⣿⡿ ⠘⣿⣿⡏  ⢻⣷⣄⣀⣠⣶⠆ ⢸⣿  ⣿⣿',
  ' ⠈⠙⠛⠛⠉   ⠉⠉    ⠈⠙⠛⠋⠈⠉⠁  ⠉⠛⠛⠋⠁   ⠈⠉⠁  ⠉⠉    ⠉⠛⠛⠋⠁  ⠈⠉  ⠉⠉',
];

const BANNER_GAP = '  ';
/** Column where `well` begins in every wordmark row. */
const BANNER_WELL_COL = 30;

/** Only the dot and `well` take the accent, as in the logo. */
function bannerLines(): string[] {
  return BANNER_ICON.map((icon, i) => {
    const cells = [...BANNER_WORD[i]];
    const word = cells.slice(0, BANNER_WELL_COL).join('') + style.brand(cells.slice(BANNER_WELL_COL).join(''));
    return `${paintMark(icon)}${BANNER_GAP}${word}`;
  });
}

/** A wordmark's rows cut at `well`, kept as drawn for one line and trimmed flush left for two. */
interface Wordmark { line: Array<[string, string]>; orde: string[]; well: string[] }

function wordmark(rows: string[], wellCol: number): Wordmark {
  const line = rows.map((row): [string, string] => [[...row].slice(0, wellCol).join(''), [...row].slice(wellCol).join('').trimEnd()]);
  const indent = Math.min(...line.map(([, well]) => well.length - well.trimStart().length));
  return { line, orde: line.map(([orde]) => orde.trimEnd()), well: line.map(([, well]) => well.slice(indent)) };
}

const BANNER_WORDMARK = wordmark(BANNER_WORD, BANNER_WELL_COL);

const oneLine = ({ line }: Wordmark): string[] => line.map(([orde, well]) => orde + style.brand(well));
const twoLines = ({ orde, well }: Wordmark): string[] => [...orde, ...well.map((row) => style.brand(row))];

/**
 * The largest logo the pane has room for, with the whole welcome under it: the
 * full banner, then the wordmark alone on one line, then on two. A pane too
 * small for all three goes without — the Setup block matters more than the logo.
 */
function welcomeLogo(restRows: number, rows: number, cols: number): string[] {
  return [bannerLines(), oneLine(BANNER_WORDMARK), twoLines(BANNER_WORDMARK)]
    .find((lines) => lines.every((line) => width(line) <= cols - 1) && lines.length + restRows <= rows) ?? [];
}

const DETECTING = 'Detecting coding agents…';
const CHECKING_REPOSITORIES = 'Checking repositories…';

/**
 * What the welcome says about the repositories a run would isolate. The words
 * are core's shared notice, so the terminal and the editor cannot drift. A
 * ready group's note is dropped to keep the welcome compact; a dirty tree's
 * decision and a failure's reason are the parts a run is waiting on.
 */
function isolationPreviewLines(state: TuiState, cols: number): string[] {
  const room = Math.max(1, cols - 1);
  const head = style.bold('Repositories and branches');
  const preview = state.isolationPreview;
  if (!preview) {
    // `undefined` is before the first read, `null` while one is in flight:
    // neither knows a repository, so neither may claim there is none.
    return [head, ...wrap(style.grey(CHECKING_REPOSITORIES), room), ''];
  }
  const notice = describeIsolationPreview(preview);
  const important = preview.status === 'dirty' || preview.status === 'failed';
  const summary = important ? style.yellow(notice.summary) : notice.summary;
  return [
    head,
    ...wrap(summary, room),
    ...notice.repos.flatMap((repo) => wrap(`  ${repo.name} · ${style.grey(repo.detail)}`, room)),
    ...(notice.shared ? wrap(style.grey(notice.shared), room) : []),
    ...(notice.note && important ? wrap(style.grey(notice.note), room) : []),
    '',
  ];
}

/**
 * One red line per signed-out agent, the active planner first so the row under
 * the workspace names the command that fixes the plan at hand. A named login
 * leaves the planner alone, so every other agent names its own `/login <id>`.
 */
function signedOutPlannerLines(state: TuiState, cols: number): string[] {
  if (!state.plannerKnown || !state.runnersKnown) return [];
  const planned = runnerForProvider(state.plannerProvider);
  const flagged = state.runners.filter(signedOutWithLogin);
  const active = flagged.find((row) => row.id === planned);
  const room = Math.max(1, cols - 1);
  return (active ? [active, ...flagged.filter((row) => row !== active)] : flagged)
    .flatMap((row) => wrap(
      style.red(`${row.name} not logged in. ${row === active ? '/login' : `/login ${row.id}`} to sign in.`),
      room,
    ));
}

/**
 * The planner's value in the Setup block: harness, model and effort. A planner
 * whose own agent says the user is signed out is painted red whole, the same
 * alarm its Runners row carries (ADR-0052); signed in, unknown or vendor stays
 * as it was.
 */
function plannerRowValue(state: TuiState, label: string): string {
  const alarm = state.runners.find((row) => row.id === runnerForProvider(state.plannerProvider));
  const paint = alarm && signedOutWithLogin(alarm) ? style.red : (text: string) => text;
  const effort = plannerEffortLabel(state);
  const model = state.orchestratorModel ? paint(state.orchestratorModel) : style.yellow('no model');
  return [paint(label), model, ...(effort ? [paint(effort)] : [])].join(style.grey(' · '));
}

/** `rows` is the pane the welcome is painted into. */
function welcomeLines(state: TuiState, rows: number, cols: number): string[] {
  const planner = plannerSetup(state);
  const enabledRunners = state.runners.filter((r) => r.enabled);
  const canPlan = planner.ready
    || state.runners.length > 0
    || state.configuredProviders.length > 0;

  // Both rows wait on the daemon's probe for coding agents, as its answers do.
  const detecting = !state.plannerKnown || !state.runnersKnown;
  const plannerValue = detecting
    ? style.grey(DETECTING)
    : planner.ready
      ? plannerRowValue(state, planner.label)
      : style.yellow(planner.label === 'not set' ? 'not set' : `${planner.label} (unavailable)`);

  const prompt = wrap(style.bold('Describe a goal to start planning.'), Math.max(1, cols - 1));
  // Only true while autorun is off (ADR-0030); with it on, the same spot warns
  // instead, and until the saved setting is known it says nothing rather than guess.
  const approvalText = !state.runSettingsKnown
    ? ''
    : state.runSettings.autorun
      ? style.yellow('Autorun is on. A plan starts as soon as the planner submits it. Change it in /settings.')
      : style.grey('Nothing runs until you approve the plan.');
  const approval = approvalText ? wrap(approvalText, Math.max(1, cols - 1)) : [];
  const setup = [
    style.bold('Setup'),
    setupRow('Planner', plannerValue, '/planner', cols),
    setupRow(
      'Runners',
      detecting
        ? style.grey(DETECTING)
        : enabledRunners.length > 0
          ? enabledRunners.map((row) => (signedOutWithLogin(row) ? style.red(row.name) : row.name)).join(', ')
          : style.yellow('none enabled'),
      '/runners',
      cols,
    ),
    setupRow('Autonomy', state.autonomous ? style.yellow('Full') : 'Guarded', '', cols),
    setupRow('Run', runSettingsValue(state), '/settings', cols),
    '',
  ];
  // Only once nothing usable was found: a key reaches the welcome with the catalog, after the probe.
  const notice = canPlan || detecting || !state.providersKnown
    ? []
    : [
      ...wrap(
        style.yellow(`Install a coding agent (${runnerNamesOr()}) and pick it with /planner. No API key needed. Or add an API key with /key and choose your provider.`),
        Math.max(1, cols - 1),
      ),
      '',
    ];
  const versionCheck = state.versionCheckNotice
    ? [...wrap(style.grey(state.versionCheckNotice), Math.max(1, cols - 1)), '']
    : [];
  const tail = [
    ...notice,
    ...versionCheck,
    style.grey('/help   all commands'),
    workspaceLine(state.workspace, cols),
    ...signedOutPlannerLines(state, cols),
  ];

  const rest = ['', ...prompt, ...approval, '', ...setup, ...isolationPreviewLines(state, cols), ...tail];
  const logo = welcomeLogo(rest.length, rows, cols);
  return logo.length > 0 ? [...logo, ...rest] : rest.slice(1);
}

// ── Plan pane ────────────────────────────────────────────────────────────────

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATUS_PAINT: Record<TaskStatusKind, (text: string) => string> = {
  done: style.green,
  running: style.yellow,
  quiet: style.brand,
  failed: style.red,
  blocked: style.red,
  // Grey, not green: nothing of a skipped task landed.
  skipped: style.grey,
  awaiting: style.yellow,
  todo: (text) => text,
};

/** `quiet` is static — distinct from both the busy spinner and the awaiting '?'. */
const STATUS_ICON: Record<Exclude<TaskStatusKind, 'running'>, string> = {
  done: '✓',
  failed: '✗',
  blocked: '!',
  skipped: '»',
  awaiting: '?',
  quiet: '~',
  todo: '·',
};

/** The static glyph of a task whose runner has gone quiet, in the plan pane and on the status row. */
export const QUIET_MARK = STATUS_ICON.quiet;

/** A row's annotations run on inside a sentence, so core's sentence-case labels lose their capital. */
const inRow = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** Inclusive indices into `PlanLayout.lines`. */
export interface LineSpan {
  start: number;
  end: number;
}

/**
 * The plan pane's content and the geometry the viewport is reasoned about in.
 * `lines[0]` is the header, which the pane pins — everything below it scrolls,
 * so at offset `n` the visible body is `lines[1 + n .. n + rows - 1]`.
 */
export interface PlanLayout {
  lines: string[];
  /** One span per plan row, in row order — rows are one to many lines tall. */
  rowSpans: LineSpan[];
  /** What the viewport must keep on screen: the open prompt's caret line, else the selected row. */
  anchor: LineSpan;
  /** Rows the pane is painted at, header included. */
  rows: number;
  maxScroll: number;
}

export function planLayout(state: TuiState, rows: number, cols: number): PlanLayout {
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  const totalUsage = tasksTotalText(state.tasks);
  const unmerged = state.runMerge?.handoff.landed.length ?? 0;
  const count = `${done}/${state.tasks.length}`;
  const hints = runHints(state);
  const hint = hints.find((h) => width(`Plan ${count} · ${h}`) <= cols) ?? hints.at(-1);
  const lines = [
    truncate(`${style.bold(style.brand('Plan'))} ${style.grey(`${count}${hint ? ` · ${hint}` : ''}`)}`, cols),
    totalUsage ? style.grey(truncate(totalUsage, cols)) : '',
  ];
  if (unmerged > 0) {
    const landed = style.dim(truncate(`${unmerged} landed task${unmerged === 1 ? '' : 's'} not merged: /handoff merge`, cols));
    if (totalUsage) lines.push(landed);
    else lines[1] = landed;
  }
  const firstRowLine = lines.length;

  const rowSpans: LineSpan[] = [];
  // An expanded task starts its editor at the end of its prompt. For a long
  // prompt, keeping only the task heading visible makes edits appear to do
  // nothing because the caret is below the viewport.
  let editorLine: number | undefined;
  planRows(state).forEach((row, i) => {
    // A blank line between top-level tasks; a subtask stays tight to its parent.
    if (i > 0 && !row.parent) lines.push('');
    const taskStart = lines.length;
    const renderedTask = taskLines(state, row, i, cols);
    if (row.task.id === state.expandedTaskId && renderedTask.editorLine !== undefined) {
      editorLine = taskStart + renderedTask.editorLine;
    }
    lines.push(...renderedTask.lines);
    rowSpans.push({ start: taskStart, end: lines.length - 1 });
  });

  const selected = rowSpans[state.selectedTask] ?? { start: firstRowLine, end: firstRowLine };
  const anchor = editorLine === undefined ? selected : { start: editorLine, end: editorLine };
  return { lines, rowSpans, anchor, rows, maxScroll: Math.max(0, lines.length - rows) };
}

const clampOffset = (layout: PlanLayout, offset: number): number =>
  Math.max(0, Math.min(layout.maxScroll, offset));

/**
 * The offset that puts `span` fully on screen, moving `offset` no further than
 * that takes: one that is already visible stays put, one above lands on the
 * first body line, one below on the last. A span taller than the body cannot be
 * both, so its first line wins. Reaching the first row shows the spacer under
 * the header again rather than stopping one line short of it, when the body is
 * tall enough to hold both.
 */
export function revealOffset(layout: PlanLayout, offset: number, span: LineSpan): number {
  const at = clampOffset(layout, offset);
  const bodyHeight = layout.rows - 1;
  // The spacer under the header comes back with the first row only if the row
  // still fits under it — a one-line body would otherwise show nothing but the spacer.
  const first = span.start <= (layout.rowSpans[0]?.start ?? layout.anchor.start) && span.end <= bodyHeight ? 0 : span.start - 1;
  if (span.start < 1 + at || span.end - span.start + 1 > bodyHeight) return clampOffset(layout, first);
  if (span.end > at + layout.rows - 1) return clampOffset(layout, span.end - layout.rows + 1);
  return at;
}

/**
 * Where the plan pane's viewport actually sits: the absolute offset, clamped to
 * what exists. `null` means nothing has positioned it yet, so it is the least
 * scroll from the top that shows what the pane must keep on screen.
 */
export function planOffset(layout: PlanLayout, planScroll: number | null): number {
  if (planScroll === null) return revealOffset(layout, 0, layout.anchor);
  return clampOffset(layout, planScroll);
}

/**
 * The first row a viewport at `offset` shows in full, else the one covering its
 * top line — paging forward lands the selection where the reader's eye starts.
 */
export function topRowInView(layout: PlanLayout, offset: number): number {
  const top = 1 + offset;
  const whole = layout.rowSpans.findIndex((span) => span.start >= top && span.end <= offset + layout.rows - 1);
  if (whole >= 0) return whole;
  const covering = layout.rowSpans.findIndex((span) => span.end >= top);
  return covering >= 0 ? covering : layout.rowSpans.length - 1;
}

/** The mirror of `topRowInView`, for paging back. */
export function bottomRowInView(layout: PlanLayout, offset: number): number {
  const bottom = offset + layout.rows - 1;
  const spans = layout.rowSpans;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].start >= 1 + offset && spans[i].end <= bottom) return i;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].start <= bottom) return i;
  }
  return 0;
}

/**
 * The row to keep selected once the viewport has moved to `offset`: the same
 * one while any of it is still on screen, otherwise the nearest one that is.
 */
export function rowNearestView(layout: PlanLayout, offset: number, row: number): number {
  const span = layout.rowSpans[row];
  if (!span) return row;
  if (span.end < 1 + offset) return topRowInView(layout, offset);
  if (span.start > offset + layout.rows - 1) return bottomRowInView(layout, offset);
  return row;
}

/** The plan pane's geometry at the size it is about to be painted. */
export function planScrollExtent(state: TuiState): PlanLayout {
  const { plan } = bodyPanes(state);
  // A pane with no room has nothing to scroll; measuring it anyway would
  // invent an offset the user can never see.
  if (!plan || plan.rows === 0) {
    return { lines: [], rowSpans: [], anchor: { start: 0, end: 0 }, rows: 0, maxScroll: 0 };
  }
  return planLayout(state, plan.rows, plan.cols);
}

/** The discovered catalog per runner, rebuilt from the models each was tagged with, so an allowlist is read as the planner reads it. */
function modelsByRunnerOf(models: readonly ModelView[]): Record<string, DiscoveredModel[]> {
  const out: Record<string, DiscoveredModel[]> = {};
  for (const m of models) {
    for (const runner of m.runners ?? []) (out[runner] ??= []).push({ modelId: m.id, modelLabel: m.label, variants: [] });
  }
  return out;
}

interface TaskLines {
  lines: string[];
  /** The zero-based line within `lines` containing the prompt editor caret. */
  editorLine?: number;
}

function taskLines(state: TuiState, planRow: PlanRow, index: number, cols: number): TaskLines {
  const { task, parent } = planRow;
  // Before the runners load, every task would read as on a runner that is off.
  const runnerScope = state.runners.length > 0
    ? { enabledRunners: state.runners.filter((r) => r.enabled).map((r) => r.id), allowlist: state.allowlist, models: modelsByRunnerOf(state.models) }
    : undefined;
  const row = taskRowView(task, { parent, tasks: state.tasks, modes: modesForTask(state.modesByRunner, task), runnerScope });
  const selected = state.focus === 'plan' && index === state.selectedTask;
  const expanded = state.expandedTaskId === task.id;
  const rawIcon = row.status === 'running' ? SPINNER[state.spinnerFrame % SPINNER.length] : STATUS_ICON[row.status];
  const icon = STATUS_PAINT[row.status](rawIcon);
  const kind = row.running
    ? style.yellow('RUN')
    : row.kind === 'user'
      ? style.yellow('MAN')
      : row.kind === 'script'
        ? style.cyan('SCR')
        : row.kind === 'ops'
          ? style.magenta('OPS')
          : row.research
            ? style.cyan('RES')
            : style.grey(' AI');
  const caret = selected ? style.brand('❯') : ' ';

  // A subtask row names itself by its dotted order ("2.1") and steps in under
  // its parent; the top-level order number keeps its two-wide pad.
  const orderLabel = parent ? row.orderLabel : row.orderLabel.padStart(2);
  const indent = parent ? '  ' : '';
  const head = `${indent}${caret} ${icon} ${orderLabel} ${kind} `;
  const titleRoom = Math.max(1, cols - width(head));
  const wrappedTitle = wrap(task.title, titleRoom);
  const shownTitle = expanded ? wrappedTitle : wrappedTitle.slice(0, 2);
  if (!expanded && wrappedTitle.length > shownTitle.length) {
    const last = shownTitle.length - 1;
    shownTitle[last] = truncate(`${shownTitle[last]}…`, titleRoom);
  }
  const continuation = ' '.repeat(width(head));
  const lines = shownTitle.map((line, lineIndex) => {
    const prefix = lineIndex === 0 ? head : continuation;
    return prefix + (selected ? style.bold(line) : line);
  });

  const model = task.assignedModel?.modelLabel ?? (task.type === 'ai' ? 'default model' : '');
  const effort = task.type === 'ai'
    ? `effort: ${task.assignedModel?.thinkingEffort ?? 'default'}`
    : '';
  const mode = task.type === 'ai'
    ? `mode: ${task.taskMode ?? 'default'}${row.autonomous ? style.yellow(' ⚡') : ''}`
    : '';
  const runner = row.runner ?? '';
  const bodyPad = parent ? '      ' : '    ';
  // Only a state that wants the user gets a word: a runner approval ("enter
  // opens it") and a task stopped at a question — and a report received while
  // its attempt winds down, or a runner still connecting Ordewell's tools,
  // which the spinner alone would hide. Running and
  // quiet are the status glyph's job — the spinner and the static '~' — so a
  // running row reads `runner · model` and nothing is repeated above it.
  const activity = row.approvals
    ? `${inRow(row.approvals)}: enter opens it`
    : row.awaiting ? inRow(row.awaiting) : row.receipt ? inRow(row.receipt) : row.attaching ? inRow(row.attaching) : '';
  const skills = (task.skills ?? []).join(' · ');
  // A running row's tag says RUN, so the mark moves to the line beneath it.
  const meta = [activity, ...(row.research && row.running ? [style.cyan('research')] : []), runner, model];
  // The variant rides on the meta line only when the whole line still fits;
  // when it does not, the effort gives way rather than truncating the model.
  const variant = task.type === 'ai' ? sanitize(task.assignedModel?.thinkingEffort ?? '') : '';
  const withVariant = variant ? [...meta, variant] : meta;
  const metaLine = variant && width(`${continuation}${withVariant.filter(Boolean).join(' · ')}`) <= cols
    ? withVariant
    : meta;
  const metaText = metaLine.filter(Boolean).join(' · ');
  // Runner and model hang under the title. Warnings and the expanded sheet
  // keep the shallower `bodyPad`: they need the room more than the alignment.
  if (metaText) lines.push(style.grey(truncate(`${continuation}${metaText}`, cols)));
  if (row.loop) lines.push(...loopLines(row.loop, cols, bodyPad));
  // The one isolation state that needs the user; every other stays out of the
  // row and shows only in the expanded detail below.
  if (row.conflict) {
    const where = row.conflict.repo ? ` in ${row.conflict.repo}` : '';
    const files = row.conflict.files ? ` (${row.conflict.files})` : '';
    const held = row.conflict.resolver ? `task ${row.conflict.resolver} is resolving it` : 'its work is kept on its own branch';
    lines.push(...statusLines(style.red, '⚠', `merge conflict${where}${files}: ${held}`, cols, bodyPad));
  }
  // It starts by itself, so it is no warning; `c` withdraws it.
  if (row.repairWaiting) {
    const files = row.repairWaiting.files ? ` (${row.repairWaiting.files})` : '';
    lines.push(...statusLines(style.yellow, '⏸', `${inRow(row.repairWaiting.label)}${files}`, cols, bodyPad));
  }
  // `attempt` is absent only for a task shown straight from a reloaded plan,
  // before the live stream has caught up.
  if (row.repairing) {
    const files = row.repairing.files ? ` in ${row.repairing.files}` : '';
    const attempt = row.repairing.attempt ? ` (attempt ${row.repairing.attempt.attempt}/${row.repairing.attempt.limit})` : '';
    lines.push(...statusLines(style.yellow, '↻', `repairing conflict${files}${attempt}`, cols, bodyPad));
  }
  // A merge gate holds the task as plainly as a task that waits on the user (ADR-0020).
  if (row.mergeGate) {
    lines.push(...statusLines(style.yellow, '⏸', `waits for Merge all: ${row.mergeGate.join(', ')} not merged into your branch yet`, cols, bodyPad));
  }
  // Named as it is, not lowercased like the other labels: a model's label is a proper name.
  if (row.assignmentFlag) {
    lines.push(...statusLines(style.yellow, '⚠', assignmentFlagText(row), cols, bodyPad));
  }
  if (row.waitsForApproval) {
    lines.push(...statusLines(style.yellow, '⏸', `${inRow(row.waitsForApproval)} · f approves it · /run approves all`, cols, bodyPad));
  }
  if (row.holdReason) {
    lines.push(...statusLines(style.yellow, '⏸', `${inRow(holdLabel(row.holdReason))} · retry or f start when ready`, cols, bodyPad));
  }
  if (row.blockedBy) {
    lines.push(...statusLines(style.red, '⊘', `${inRow(blockedByLabel(row.blockedBy))}: runs once ${row.blockedBy.length === 1 ? 'it is retried and passes' : 'they are retried and pass'}`, cols, bodyPad));
  }
  if (row.status === 'skipped') {
    lines.push(...statusLines(style.grey, '»', `${inRow(skippedLabel(row.skipReason))}: nothing of it landed; m done lands its kept work`, cols, bodyPad));
  }
  const resumable = row.actions.includes('resume-now');
  if (row.resumes) {
    lines.push(...statusLines(style.yellow, '⏸', `${inRow(row.resumes)}, once the usage limit resets: ${resumable ? 'r resume now · ' : ''}c don't resume`, cols, bodyPad));
  } else if (resumable) {
    lines.push(...statusLines(style.yellow, '⏸', 'waits for the usage limit to reset: r resume now', cols, bodyPad));
  }
  if (row.opsChangedFiles) {
    lines.push(...statusLines(style.yellow, '⚠', 'an ops task changed tracked files: check them, then m done or /retry', cols, bodyPad));
  }
  if (row.repaired?.landed) {
    lines.push(...statusLines(style.grey, '↻', `landed after repairing conflict in ${row.repaired.files}`, cols, bodyPad));
  }

  let editorLine: number | undefined;
  if (expanded) {
    if (row.handoff) {
      // The commit subject and summary are the author's text, so they are cleaned here rather than in core.
      lines.push(...taskText('Handoff', handoffPeekParts(row.handoff).map(sanitize).join(' · '), cols, bodyPad));
    }
    if (skills) lines.push(style.grey(truncate(`${bodyPad}skills: ${skills}`, cols)));
    if (effort || mode) lines.push(style.grey(truncate(`${bodyPad}${[effort, mode].filter(Boolean).join(' · ')}`, cols)));
    lines.push(style.grey(`${bodyPad}${STATUS_WORD[taskStatusKind(task)]}`));
    if (task.isolation && task.isolation.state !== 'none' && task.isolation.branch) {
      lines.push(...taskText('Branch', task.isolation.branch, cols, bodyPad));
      if (row.repos.length > 0) lines.push(...taskText('Repos', row.repos.join(', '), cols, bodyPad));
      // An integrated task's worktree is gone; naming it would point at nothing.
      if (task.isolation.state !== 'integrated' && task.isolation.worktree) {
        lines.push(...taskText('Worktree', task.isolation.worktree, cols, bodyPad));
      }
    }
    if (row.research) {
      lines.push(...taskText('Research', 'Read-only: it lands nothing. Its report wakes the planner when it ends.', cols, bodyPad));
    }
    if (row.kind === 'ops') {
      lines.push(...taskText('Ops', 'Runs in your checkout, not a worktree, once the work it depends on is merged. O makes it a change task.', cols, bodyPad));
    }
    // Where an ops task shows its prompt: the body is what runs and what the
    // user consented to, so it is shown whole and verbatim (ADR-0035).
    if (row.kind === 'script') {
      lines.push(...taskText('Script', scriptTaskText(task).replace(/\t/g, '    '), cols, bodyPad));
      lines.push(...taskText('Ops', 'Runs in your checkout with no model, once the work it depends on is merged.', cols, bodyPad));
    }
    if (row.forcedPastGate) {
      lines.push(...taskText('Forced', `Started before the work of ${row.forcedPastGate.join(', ')} was merged into your branch.`, cols, bodyPad));
    }
    if (row.autonomous) {
      lines.push(...taskText('Autonomy', 'Runs without permission prompts (Full). Change the level with /settings.', cols, bodyPad));
    }
    // The prompt editor is seeded from prompt ?? description ?? title, so only
    // show the static description when it carries information the editor won't.
    const editableSeed = row.kind === 'script' ? task.title : task.prompt ?? task.description ?? task.title;
    if (task.description && task.description !== task.title && task.description !== editableSeed) {
      lines.push(...taskText('Description', task.description, cols, bodyPad));
    }
    if (state.taskEditor) {
      // Wrap the prompt once and derive both the caret's line (for scroll
      // anchoring) and the painted rows from it — a second `cursorPosition`
      // call would re-wrap the whole prompt every frame.
      const room = Math.max(1, cols - width(bodyPad));
      const wrapped = wrapLines(state.taskEditor.text, room);
      const cp = cursorInLines(wrapped, state.taskEditor.cursor, state.taskEditor.text.length);
      editorLine = lines.length + 1 + cp.line;
      lines.push(...taskPromptLines(wrapped, cp, bodyPad));
    }
    if (row.dependencies.length > 0) {
      lines.push(...taskText('Depends on', row.dependencies.join(', '), cols, bodyPad));
    }
    // A script's body is the planner's to write: there is no editor to save or cancel.
    if (row.kind === 'script') {
      lines.push(style.grey(`${bodyPad}esc collapse · f start · D deps · d remove`));
      return { lines, editorLine };
    }
    // Two lines: the assignment keys plus the edit verbs no longer fit the plan
    // pane on one, and a truncated hint hides the keys it exists to teach. They
    // are named as what leaving the editor gets you, not as keys that work here
    // — while the prompt is open every letter types into it.
    lines.push(style.grey(`${bodyPad}enter save · esc cancel`));
    lines.push(style.grey(truncate(`${bodyPad}then R runner · o model · e effort · M mode · D deps · K skills`, cols)));
  }

  return { lines, editorLine };
}

/**
 * A row's status line, wrapped under its glyph rather than cut off at the
 * pane's edge: it says what the user can do, and the end of it is the part
 * they act on.
 */
const LOOP_PAINT: Record<LoopCheckState, (text: string) => string> = {
  waiting: style.grey,
  running: style.grey,
  repeating: style.yellow,
  stopped: style.red,
  passed: style.green,
  'out-of-rounds': style.red,
  failed: style.red,
  ended: style.grey,
};

/**
 * A loop's check and body are linked by the same glyph and the check's
 * reference (ADR-0045): the check says its round and which tasks run if it
 * fails, and each of those says which check it runs for.
 */
function loopLines(loop: TaskRowLoop, cols: number, pad: string): string[] {
  const paint = loop.role === 'body' ? style.cyan : LOOP_PAINT[loop.state];
  return statusLines(paint, '↻', loopRowParts(loop).map(inRow).join(' · '), cols, pad);
}

function statusLines(paint: (text: string) => string, glyph: string, text: string, cols: number, pad: string): string[] {
  const lead = `${pad}${glyph} `;
  const room = Math.max(1, cols - width(lead));
  return wrap(text, room).map((line, i) => paint(`${i === 0 ? lead : ' '.repeat(width(lead))}${line}`));
}

function taskText(label: string, text: string, cols: number, pad = '    '): string[] {
  const room = Math.max(1, cols - width(pad));
  return [
    style.grey(`${pad}${label}`),
    ...wrap(text, room).map((line) => `${pad}${line}`),
  ];
}

/** Paints an already-wrapped prompt with its caret. Indented to match taskText. */
function taskPromptLines(wrapped: WrapLine[], cursor: CursorPosition, pad = '    '): string[] {
  return [
    style.grey(`${pad}Prompt`),
    ...wrapped.map(({ line }, i) => {
      if (i !== cursor.line) return `${pad}${line}`;
      const col = cursor.col;
      const caret = firstGrapheme(line.slice(col)) || ' ';
      return `${pad}${line.slice(0, col)}${style.inverse(caret)}${line.slice(col + caret.length)}`;
    }),
  ];
}

// ── Help overlay ─────────────────────────────────────────────────────────────

const CATEGORY_TITLE: Record<SlashCategory, string> = {
  planning: 'Planning',
  tasks: 'Tasks',
  models: 'Models & providers',
  skills: 'Skills',
  session: 'Sessions',
  system: 'System',
};

/** Which sheet the help overlay shows: the slash commands, or the plan pane's keys (`?`). */
export type HelpSheet = 'commands' | 'keys';

/**
 * The sheet, the rows of it that fit, and how far it scrolls. The sheet
 * is taller than most terminals, and it is the one overlay with an offset of
 * its own — so it needs the same exact bound the panes do.
 */
export interface HelpLayout {
  lines: string[];
  /** Rows of the sheet the frame can show at once. */
  room: number;
  maxScroll: number;
}

/** The key sheet's rows: one table, grouped, built from the entries the footer picks its hints from. */
function keySheetBody(cols: number): string[] {
  const body: string[] = [];
  for (const [group, keys] of planKeysByGroup()) {
    body.push(style.bold(group));
    for (const { keys: label, meaning } of keys) {
      body.push(`  ${pad(label, Math.min(14, cols - 6))} ${style.grey(meaning)}`);
    }
    body.push('');
  }
  body.push(
    style.bold('While editing a task prompt'),
    ...TASK_EDITOR_KEYS.map(({ keys, meaning }) => `  ${pad(keys, Math.min(14, cols - 6))} ${style.grey(meaning)}`),
  );
  return body;
}

function commandSheetBody(cols: number): string[] {
  const body: string[] = [];
  for (const [category, title] of Object.entries(CATEGORY_TITLE) as [SlashCategory, string][]) {
    const commands = slashCommandTable().filter((c) => c.category === category);
    if (commands.length === 0) continue;
    body.push(style.bold(title));
    for (const command of commands) {
      body.push(`  ${pad(command.usage, Math.min(38, cols - 6))} ${style.grey(command.description)}`);
    }
    body.push('');
  }
  body.push(
    style.grey('tab switches panes · pgup/pgdn scroll · ctrl-o toggles full detail · esc takes back a queued prompt, otherwise esc twice stops · ctrl-l clears · ctrl-c quits'),
    style.grey('alt-enter inserts a newline · ? lists the plan pane\'s keys, once tab has put you there'),
    style.grey('  in the planner chat, ctrl-s sends now: stops the running planner turn and sends the composer text next: or, with it empty, the newest queued prompt'),
  );
  // One line each: the sheet clips every line to the frame, and the task
  // view's keys run far past any width on a single one.
  body.push(
    '',
    style.bold('In a task chat (enter on a started task)'),
    style.grey('  ctrl-s sends now: interrupts the running step, then delivers the composer text or, with it empty, the highlighted pending message'),
    style.grey('  ctrl-n/ctrl-p pick a pending message (the newest until you do) · ctrl-r removes a queued one'),
    style.grey('  ctrl-x stops the runner\'s running turn, and it then waits for your next message: on a task paused on a usage limit, it keeps it from resuming'),
    style.grey('  ctrl-y allows a tool request (its keys sit under it) · ctrl-t allows it for the task · ctrl-g denies it, with the composer text as the note'),
    style.grey('  at a checkpoint, enter replies with what you typed, ctrl-y approves, ctrl-g rejects (the text is its reason) · /checkpoint <id> approve|reject [reason] from anywhere'),
    style.grey('  alt←/→ changes attempt · esc returns'),
  );
  return body;
}

export function helpLayout(rows: number, cols: number, sheet: HelpSheet = 'commands'): HelpLayout {
  const body = sheet === 'keys' ? keySheetBody(cols) : commandSheetBody(cols);

  // The sheet is a table: clip long descriptions to one row each rather than
  // wrapping them, which would break the two-column alignment.
  const lines = body.map((line) => truncate(line, Math.max(1, cols - 2)));
  // One row for the frame's title, one for the sheet's own footer.
  const room = Math.max(1, rows - 2);
  return { lines, room, maxScroll: Math.max(0, lines.length - room) };
}

const APPROVAL_HEADLINE: Record<ApprovalRequestView['kind'], string> = {
  shell_command: 'The planner wants to run a command',
  url_fetch: 'The planner wants to fetch a URL',
  web_search: 'The planner wants to search the web',
  mcp_tool: 'The planner wants to use an MCP tool',
  mcp_server: 'The planner wants to start a project MCP server',
  task_start: 'The planner wants to start work',
  external_path: 'The planner wants to read a path outside the workspace',
};

export interface ApprovalLayout {
  /** The card under its title bar: the request, the part of its body in view, and the keys. */
  lines: string[];
  maxScroll: number;
}

/**
 * The planner's approval card. A script's body is what the user consents to
 * (ADR-0035), so it is shown whole when it fits and otherwise scrolls, with the
 * lines out of view counted above and below it: the keys stay on screen, and
 * nothing is cut without saying so.
 */
export function approvalLayout(state: TuiState, request: ApprovalRequestView, scroll: number, rows: number, cols: number): ApprovalLayout {
  const inner = Math.max(1, cols - 2);
  const wrapped = (lines: string[]): string[] => lines.flatMap((line) => wrap(line, inner));
  const queued = state.pendingApprovals.length;
  const head = wrapped([APPROVAL_HEADLINE[request.kind], '', `  ${style.yellow(request.subject)}`, '']);
  const foot = wrapped([
    ...(request.body ? [''] : []),
    // Disambiguates the `external_path` case: an auto-tier command like
    // `cat` touching an outside path reads identically to a plain
    // `read_file` without it.
    ...(request.detail ? [style.grey(request.detail), ''] : []),
    // The grant is wider than the request, so name it rather than letting
    // the user discover it when the next call silently does not prompt. A
    // start is asked every time (ADR-0029), so it grants nothing more.
    ...(request.kind === 'task_start' ? [] : [style.grey(`Approving also allows ${request.scope} for the rest of this session.`)]),
    ...(queued > 0 ? [style.grey(`${queued} more waiting.`)] : []),
    '',
    // ESC is not "deny" while a turn is in flight — it kills the turn and
    // takes this prompt with it. Offering it as the deny key there would
    // teach the wrong thing about the most destructive key on the sheet.
    // With a prompt queued the first ESC unsends that instead, so the hint
    // names the take-back rather than the twice-to-stop.
    style.grey(plannerInFlight(state)
      ? state.queuedPrompts.length > 0
        ? 'y or enter allows · n denies · esc takes back the queued prompt'
        : 'y or enter allows · n denies · esc twice stops planning'
      : 'y or enter allows · n or esc denies'),
  ]);
  const body = request.body ? wrap(sanitize(request.body).replace(/\n+$/, '').replace(/\t/g, '    '), Math.max(1, inner - 2)).map((line) => `  ${line}`) : [];
  // The title bar takes a row; a window under three rows could show no line of the body between its markers.
  const room = Math.max(3, rows - 1 - head.length - foot.length);
  if (body.length <= room) return { lines: [...head, ...body, ...foot], maxScroll: 0 };
  const window = room - 2;
  const maxScroll = body.length - window;
  const top = Math.min(Math.max(0, scroll), maxScroll);
  const below = body.length - top - window;
  return {
    lines: [
      ...head,
      style.grey(top > 0 ? `  ↑ ${top} more ${top === 1 ? 'line' : 'lines'} above` : '  The start of what it runs:'),
      ...body.slice(top, top + window),
      style.grey(below > 0 ? `  ↓ ${below} more ${below === 1 ? 'line' : 'lines'} below · up/down or pgup/pgdn scrolls` : '  The end.'),
      ...foot,
    ],
    maxScroll,
  };
}

/** How far the approval card's body can scroll at the size it is about to be painted. */
export function approvalScrollMax(state: TuiState): number {
  const overlay = state.overlay;
  return overlay?.kind === 'approval' ? approvalLayout(state, overlay.request, 0, bodyRows(state), state.cols).maxScroll : 0;
}

/** How far the help sheet can scroll at the size it is about to be painted. */
export function helpScrollMax(state: TuiState): number {
  const sheet = state.overlay?.kind === 'help' ? state.overlay.sheet : undefined;
  return helpLayout(bodyRows(state), state.cols, sheet).maxScroll;
}
