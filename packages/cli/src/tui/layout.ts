import { pad, style, truncate, width, wrap, wrapLines, type WrapLine } from './ansi';
import { cursorInLines, type CursorPosition } from './editor';
import { checkpointCardLines, conversationLines, tokenLine } from './blocks';
import { chatEditorRoomFor, chatPaneWidth, planPaneWidth } from './geometry';
import { SLASH_COMMANDS, type SlashCategory } from './slash';
import { findTask, planRows, plannerInFlight, selectedPlanRow, waitingApproval, waitingCheckpoint, type PlanRow, type TaskView, type TuiState } from './state';
import { modesForTask } from './taskAssignment';
import { ALL_PROVIDERS, approvalLabel, awaitingLabel, hasHiddenDetail, markAction, runnerForProvider, taskRowView, type AiProvider, type ApprovalBlock, type DisplayBlock, type QueuedTaskMessage, type TaskStatusKind } from '@ordewell/core';

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

/** skills, status, input, footer — everything that is not the body. */
const CHROME_ROWS = 4;

// ── Chrome extents ───────────────────────────────────────────────────────────

/**
 * The chat input's wrapped lines, or `null` when the editor is blurred and
 * therefore always exactly one row (a literal newline would otherwise push
 * every row below it down one line).
 */
export function chatInputWrap(state: TuiState): WrapLine[] | null {
  const active = state.focus === 'chat' && !state.overlay;
  if (!active) return null;
  return wrapLines(state.editor.text, chatEditorRoomFor(state, true));
}

/**
 * The footer's key hints, unpainted. Kept next to the body extents because the
 * footer's height is what is left over for the body — the plan pane's list is
 * longer than a normal terminal is wide and routinely wraps to two rows.
 */
export function footerHints(state: TuiState): string[] {
  // `m` toggles, so the hint has to name the direction it will actually go for
  // the selected task — a fixed 'm done' on a finished task reads as a no-op.
  const selected = selectedPlanRow(state)?.task;
  const markHint = selected && markAction(selected) === 'uncomplete' ? 'm undone' : 'm done';
  // Only on a task that has a conflict to resolve: isolation stays quiet otherwise.
  const resolveHint = selected?.isolation?.state === 'conflict' ? ['x resolve conflict'] : [];
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
  const escHint = !planning ? null
    : state.queuedPrompts.length > 0 ? 'esc unsend'
    : 'esc ×2 stop planning';

  if (state.focus === 'plan') {
    // `expandedTaskId` alone only means subtask rows are revealed — the editor
    // hints belong to `taskEditor`, or a browsing parent would claim its keys
    // type into a prompt draft that isn't actually open.
    if (state.taskEditor) {
      return ['type to edit prompt', 'pgup/pgdn scroll', 'alt-enter newline', 'enter save', 'esc cancel'];
    }
    return [
      ...(escHint ? [escHint] : []),
      'enter expand', 'R runner', 'o model', 'e effort', 'M mode', 'D deps', 'K skills', 'O ops', 'f start',
      'E run plan', 'S stop', 'c cancel', markHint, 's skip', 'a add', 'd remove', 't terminal', ...resolveHint,
      'pgup/pgdn scroll', 'tab chat',
    ];
  }
  // The detail-all toggle names the direction it will go, like `m done` does.
  // Shown only once the conversation holds something it can expand: the
  // welcome alone must keep the footer to one row, or a 24-row terminal
  // loses the logo's last line.
  const detailHint = hasHiddenDetail(state.taskView ? state.taskView.view.blocks : state.conversation.blocks)
    ? [state.detailAll ? 'ctrl-o collapse all' : 'ctrl-o expand all']
    : [];
  return [
    '/help', 'tab plan', 'alt-enter newline', 'pgup/pgdn scroll',
    ...detailHint,
    ...(escHint ? [escHint] : []),
    'ctrl-c quit',
  ];
}

/**
 * The queue's bubbles, one bubble per prompt, in queue order. Not part of the
 * conversation view: a prompt joins it only once it is sent.
 */
export function queuedPromptRows(state: TuiState, cols: number): string[] {
  return state.queuedPrompts.flatMap((text) => queuedBubble(text, cols));
}

/** One queued prompt wrapped under a dimmed marker, the takeback hint on its first row. */
function queuedBubble(text: string, cols: number): string[] {
  const room = Math.max(1, cols - width('◇  · queued · esc to unsend'));
  return wrap(text, room).map((line, i) => i === 0
    ? truncate(`${style.grey(`◇ ${line}`)} · queued · esc to unsend`, cols)
    : truncate(style.grey(`  ${line}`), cols));
}

/**
 * The task view's undelivered messages, one bubble each, in queue order. A
 * queued message has not reached the runner yet, and the highlighted one is
 * what ctrl-r takes back (and, with the composer empty, what ctrl-s sends
 * now); a handed-over one the runner already has and will show the model at
 * its next step; a forced one goes once the running turn is interrupted
 * (ADR-0023).
 */
export function taskQueuedRows(state: TuiState, cols: number): string[] {
  const tv = state.taskView;
  if (!tv) return [];
  return tv.view.queued.flatMap((message, i) => queuedTaskBubble(message, i === tv.queuedIndex, cols));
}

function queuedTaskTag({ handedOver, forced }: QueuedTaskMessage, selected: boolean): string {
  if (forced) return ' · sending now';
  if (handedOver) return ' · handed over';
  return selected ? ' · queued · ctrl-r removes' : ' · queued';
}

function queuedTaskBubble(message: QueuedTaskMessage, selected: boolean, cols: number): string[] {
  const { text } = message;
  const marker = selected ? style.accent('❯') : style.grey('◇');
  const tag = queuedTaskTag(message, selected);
  const room = Math.max(1, cols - width(`❯ ◇  ${tag}`));
  return wrap(text, room).map((line, i) => i === 0
    ? truncate(`${marker} ${selected ? style.bold(line) : line}${style.grey(tag)}`, cols)
    : truncate(`  ${line}`, cols));
}

/**
 * What the task view's state is, in the header's words: a runner request
 * waiting for an answer wins — the turn is live but stopped on it — then a
 * live turn, then what an `awaiting_user` task waits on (a checkpoint over
 * plain input), then the task's own status.
 */
function taskActivity(task: TaskView | undefined, working: boolean): string {
  const approvals = approvalLabel(task?.awaitingApproval);
  if (approvals) return inRow(approvals);
  if (working) return 'working';
  if (task?.status === 'awaiting_user') return inRow(awaitingLabel(task) ?? 'Waiting for your input');
  return task?.status ?? '';
}

/** The task view's two pinned rows: the accent bar, and the keys it owns. */
function taskHeaderLines(state: TuiState, tv: NonNullable<TuiState['taskView']>, cols: number): string[] {
  const task = findTask(state.tasks, tv.taskId);
  const parts = [
    `→ Task ${task?.order ?? '?'}`,
    task?.title ?? '(task removed)',
    task?.assignedRunner ?? '',
    taskActivity(task, tv.view.working),
  ].filter(Boolean);
  const approval = waitingApproval(tv);
  const hint = approval
    ? ['ctrl-y allow', ...(approval.allowForTask ? ['ctrl-t allow for task'] : []), 'ctrl-g deny (composer text is the note)']
    : waitingCheckpoint(task)
      ? ['ctrl-y approve', 'ctrl-g reject (composer text is the reason)', 'ctrl-x interrupt']
      : ['ctrl-r remove queued', 'ctrl-x interrupt', 'ctrl-s send now'];
  if (approval && waitingCheckpoint(task)) hint.push('then the checkpoint');
  const index = tv.attempts.indexOf(tv.attempt);
  if (tv.attempts.length > 1) hint.push(`alt←/→ attempt ${index >= 0 ? index + 1 : 1}/${tv.attempts.length}`);
  hint.push('esc back');
  return [
    style.accent(truncate(parts.join(' · '), cols)),
    style.grey(truncate(hint.join(' · '), cols)),
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
  const input = chatInputWrap(state)?.length ?? 1;
  const footer = packHints(footerHints(state), state.cols).length;
  return Math.max(0, state.rows - CHROME_ROWS - input - footer + 2);
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
  // plan pane owns the screen and the chat column is too narrow for the art.
  const welcome = !tv && state.tasks.length === 0;
  // Not a block of the runner's log, so it stays out of the memoised body.
  const checkpoint = tv ? waitingCheckpoint(findTask(state.tasks, tv.taskId)) : undefined;
  const card = tv && checkpoint ? checkpointCardLines(findTask(state.tasks, tv.taskId)?.order ?? 0, checkpoint, cols, waitingApproval(tv) !== undefined) : [];
  const answering = chatBodyLines(blocks, cols, state.detailAll, tv ? waitingApproval(tv) : undefined);
  const body = card.length > 0 ? [...answering, ...card] : answering;
  const transcript = !welcome ? body : body.length === 0 ? welcomeLines(state, cols) : [...welcomeLines(state, cols), '', ...body];
  // The queued prompts paint as part of the tail, newest last — they are the
  // turns that have not gone out yet, and they travel where a sent message
  // would have appeared. A task's queue is its own, taken back one at a time.
  const bubbles = tv ? taskQueuedRows(state, cols) : queuedPromptRows(state, cols);
  const lines = [...transcript, ...(bubbles.length > 0 ? ['', ...bubbles] : [])];
  const header = tv ? taskHeaderLines(state, tv, cols) : [];
  // The token line is the session's, not a line of the transcript: it keeps
  // the pane's bottom row while everything above it scrolls — unless the pane
  // is a single row, which belongs to the conversation.
  const usage = rows > 1 ? tokenLine(blocks, cols) : null;
  const footer = usage ? [usage] : [];
  const room = Math.max(0, rows - header.length - footer.length);
  // Content that fits hangs off the top so the welcome does not jump when the
  // first message lands; once it overflows the newest lines win the pane.
  return { lines, header, footer, anchor: lines.length > room ? 'bottom' : 'top', maxScroll: Math.max(0, lines.length - room) };
}

/** How far back the chat pane can be scrolled at the size it is about to be painted. */
export function chatScrollMax(state: TuiState): number {
  return chatLayout(state, bodyRows(state), chatPaneWidth(state)).maxScroll;
}

// ── Welcome ──────────────────────────────────────────────────────────────────

/**
 * The planner backend as the welcome should name it, and whether it can
 * actually run: a coding agent needs its CLI installed, a vendor needs a key.
 */
function plannerSetup(state: TuiState): { label: string; ready: boolean } {
  const provider = state.plannerProvider as AiProvider;
  const registration = ALL_PROVIDERS[provider];
  if (!registration) return { label: 'not set', ready: false };
  const runner = runnerForProvider(provider);
  const ready = runner
    ? state.runners.some((r) => r.id === runner)
    : state.configuredProviders.includes(provider);
  return { label: registration.label, ready };
}

const SETUP_KEY_COLS = 10;
const SETUP_VALUE_COLS = 32;

function setupRow(label: string, value: string, command: string, cols: number): string {
  // Padded rather than truncated to the value column: a long model id keeps its
  // name and pushes the command right, instead of being cut to fit a grid.
  const gap = ' '.repeat(Math.max(2, SETUP_VALUE_COLS - width(value)));
  const head = `  ${style.grey(pad(label, SETUP_KEY_COLS))}${value}${gap}`;
  return truncate(`${head}${style.grey(command)}`, cols - 1);
}

// The brand mark: three strokes converging on a solid dot — the same "many
// tasks, one pipeline" idea as the logo, in the one accent colour it uses.
const ICON = `${style.bold('≫')}${style.bold(style.cyan('●'))}`;

/**
 * Unicode Mathematical Sans-Serif Bold maps 1:1 onto ASCII lowercase, so the
 * wordmark reads bold in any font without an ANSI bold escape — which a
 * later per-char colour reset would otherwise clip mid-word.
 */
function boldSans(word: string): string {
  return [...word].map((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 97 && code <= 122 ? String.fromCodePoint(0x1d5ee + (code - 97)) : ch;
  }).join('');
}

const WORDMARK = boldSans('ordewell');
const LOCKUP = `${ICON} ${WORDMARK}`;

/**
 * The logo itself, traced from the brand PDF into braille cells: three strokes
 * converging on the dot, then the lowercase wordmark in its own typeface. Each
 * row splits the icon at the dot so only the dot takes the accent colour,
 * exactly as in the logo.
 */
interface BannerRow { strokes: string; dot: string; word: string }

const BANNER_ROWS: BannerRow[] = [
  { strokes: '⠚⠻⠶⢦⣤⡀', dot: '', word: '                   ⢸⣿⡇                            ⢸⣿  ⣿⣿' },
  { strokes: '    ⠈⠙⢷⣤⡀', dot: '', word: ' ⣀⣤⣤⣤⣤⡀  ⣤⣤⢀⣤⡄ ⣀⣤⣤⣤⣸⣿⡇  ⣠⣤⣤⣤⣀ ⢠⣤⡄  ⣤⣤  ⣠⣤  ⣠⣤⣤⣤⣀  ⢸⣿  ⣿⣿' },
  { strokes: '⣀⣀⣀⣀⣀⣀⣀⣈⣻⣶⣤⣀⣀', dot: '⣀⣶⣿⣷⡄', word: '⣰⣿⠏⠁⠈⢻⣿⡆ ⣿⣿⠟⠉⠁⣰⣿⠏⠉⠉⢻⣿⡇ ⣾⡟⠁ ⠙⣿⡆ ⣿⣧ ⢸⡿⣿⡄ ⣿⡏ ⣾⡿⠁ ⠙⣿⣆ ⢸⣿  ⣿⣿' },
  { strokes: '⠉⠉⠉⠉⠉⠉⠉⢉⣽⡿⠛⠋⠉', dot: '⠉⢿⣿⡿⠃', word: '⣿⣿    ⣿⡇ ⣿⣿   ⣿⣿   ⢸⣿⡇⢸⣿⡿⠿⠿⠿⠿⠟ ⢸⣿⡀⣿⠇⢹⣇⢸⣿⠁ ⣿⡿⠿⠿⠿⠿⠿ ⢸⣿  ⣿⣿' },
  { strokes: '    ⢀⣠⡶⠛⠁', dot: '', word: '⠹⣿⣦⣀⣀⣼⣿⠃ ⣿⣿   ⠸⣿⣦⣀⣠⣾⣿⡇ ⢿⣷⣀⣀⣠⣶⠆  ⢿⣿⡿ ⠘⣿⣿⡏  ⢻⣷⣄⣀⣠⣶⠆ ⢸⣿  ⣿⣿' },
  { strokes: '⢤⣤⠶⠾⠛⠁', dot: '', word: ' ⠈⠙⠛⠛⠉   ⠉⠉    ⠈⠙⠛⠋⠈⠉⠁  ⠉⠛⠛⠋⠁   ⠈⠉⠁  ⠉⠉    ⠉⠛⠛⠋⠁  ⠉⠉  ⠉⠉' },
];

const BANNER_ICON_COLS = 18;
const BANNER_GAP = 2;
const BANNER_COLS = Math.max(
  ...BANNER_ROWS.map((row) => BANNER_ICON_COLS + BANNER_GAP + width(row.word)),
);
/** The full welcome (banner + setup + hints) needs this much terminal. */
const BANNER_MIN_ROWS = 24;

/** Column where "well" begins in every `word` row — see the cell grid in the BANNER_ROWS comment. */
const BANNER_WELL_COL = 30;

function colorWell(word: string): string {
  const cells = [...word];
  return cells.slice(0, BANNER_WELL_COL).join('') + style.cyan(cells.slice(BANNER_WELL_COL).join(''));
}

function bannerLines(rows: number, cols: number): string[] {
  if (cols < BANNER_COLS || rows < BANNER_MIN_ROWS) {
    const left = ' '.repeat(Math.max(0, Math.floor((cols - width(LOCKUP)) / 2)));
    return [left + LOCKUP];
  }
  const left = ' '.repeat(Math.floor((cols - BANNER_COLS) / 2));
  return BANNER_ROWS.map((row) => {
    const gap = ' '.repeat(BANNER_ICON_COLS + BANNER_GAP - width(row.strokes) - width(row.dot));
    return left + row.strokes + (row.dot ? style.cyan(row.dot) : '') + gap + colorWell(row.word);
  });
}

function welcomeLines(state: TuiState, cols: number): string[] {
  const planner = plannerSetup(state);
  const enabledRunners = state.runners.filter((r) => r.enabled).map((r) => r.name);
  const canPlan = planner.ready
    || state.runners.length > 0
    || state.configuredProviders.length > 0;

  const plannerValue = planner.ready
    ? [planner.label, state.orchestratorModel || style.yellow('no model')].join(style.grey(' · '))
    : style.yellow(planner.label === 'not set' ? 'not set' : `${planner.label} (unavailable)`);

  const lines = [
    ...bannerLines(state.rows, cols),
    '',
    ...wrap(style.bold('Describe a goal to start planning.'), Math.max(1, cols - 1)),
    ...wrap(
      style.grey('Ordewell researches your codebase, drafts a task plan, then runs each task in a coding agent.'),
      Math.max(1, cols - 1),
    ),
    '',
    style.bold('Setup'),
    setupRow('Planner', plannerValue, '/planner · /model', cols),
    setupRow(
      'Runners',
      enabledRunners.length > 0 ? enabledRunners.join(', ') : style.yellow('none enabled'),
      '/runners',
      cols,
    ),
    '',
  ];

  if (!canPlan) {
    lines.push(
      ...wrap(
        style.yellow('Ordewell needs one coding agent installed (Claude Code, Codex, OpenCode) — or an API key from a provider such as OpenRouter, added with /key.'),
        Math.max(1, cols - 1),
      ),
      '',
    );
  }

  lines.push(style.grey('/help   all commands'), style.grey(state.workspace));
  return lines;
}

// ── Plan pane ────────────────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATUS_PAINT: Record<TaskStatusKind, (text: string) => string> = {
  done: style.green,
  running: style.yellow,
  quiet: style.cyan,
  failed: style.red,
  blocked: style.red,
  awaiting: style.yellow,
  todo: (text) => text,
};

/** `quiet` is static — distinct from both the busy spinner and the awaiting '?'. */
const STATUS_ICON: Record<Exclude<TaskStatusKind, 'running'>, string> = {
  done: '✓',
  failed: '✗',
  blocked: '!',
  awaiting: '?',
  quiet: '~',
  todo: '·',
};

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

/** `lines[1]` is the spacer under the header, so the first task starts here. */
const FIRST_ROW_LINE = 2;

export function planLayout(state: TuiState, rows: number, cols: number): PlanLayout {
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  const lines = [style.bold(`Plan ${done}/${state.tasks.length}`), ''];

  const rowSpans: LineSpan[] = [];
  const orderOf = new Map(state.tasks.map((task) => [task.id, task.order]));
  // An expanded task starts its editor at the end of its prompt. For a long
  // prompt, keeping only the task heading visible makes edits appear to do
  // nothing because the caret is below the viewport.
  let editorLine: number | undefined;
  planRows(state).forEach((row, i) => {
    const taskStart = lines.length;
    const renderedTask = taskLines(state, row, i, cols, orderOf);
    if (row.task.id === state.expandedTaskId && renderedTask.editorLine !== undefined) {
      editorLine = taskStart + renderedTask.editorLine;
    }
    lines.push(...renderedTask.lines);
    rowSpans.push({ start: taskStart, end: lines.length - 1 });
  });

  const selected = rowSpans[state.selectedTask] ?? { start: FIRST_ROW_LINE, end: FIRST_ROW_LINE };
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
 * the header again rather than stopping one line short of it.
 */
export function revealOffset(layout: PlanLayout, offset: number, span: LineSpan): number {
  const at = clampOffset(layout, offset);
  const bodyHeight = layout.rows - 1;
  const first = span.start <= FIRST_ROW_LINE ? 0 : span.start - 1;
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
  const cols = planPaneWidth(state);
  // A pane too narrow to show has nothing to scroll; measuring it anyway would
  // wrap every title to a column and invent an offset the user can never see.
  if (cols === 0) {
    return { lines: [], rowSpans: [], anchor: { start: FIRST_ROW_LINE, end: FIRST_ROW_LINE }, rows: 0, maxScroll: 0 };
  }
  return planLayout(state, bodyRows(state), cols);
}

interface TaskLines {
  lines: string[];
  /** The zero-based line within `lines` containing the prompt editor caret. */
  editorLine?: number;
}

function taskLines(state: TuiState, planRow: PlanRow, index: number, cols: number, orderOf: ReadonlyMap<string, number>): TaskLines {
  const { task, parent } = planRow;
  const row = taskRowView(task, { parent, orderOf, modes: modesForTask(state.modesByRunner, task) });
  const selected = state.focus === 'plan' && index === state.selectedTask;
  const expanded = state.expandedTaskId === task.id;
  const rawIcon = row.status === 'running' ? SPINNER[state.spinnerFrame % SPINNER.length] : STATUS_ICON[row.status];
  const icon = STATUS_PAINT[row.status](rawIcon);
  const kind = row.running
    ? style.yellow('RUN')
    : row.kind === 'user'
      ? style.yellow('MAN')
      : row.kind === 'ops'
        ? style.magenta('OPS')
        : style.grey(' AI');
  const caret = selected ? style.cyan('❯') : ' ';

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
  const runner = task.assignedRunner ?? '';
  const bodyPad = parent ? '      ' : '    ';
  // "working" over an agent that has printed nothing for a minute hid the one
  // case that needs the user: an agent stopped at a question in its terminal.
  const structured = task.transport?.kind === 'structured';
  const activity = row.approvals
    ? `${inRow(row.approvals)} — t opens it`
    : row.status === 'quiet'
      ? (structured ? 'quiet' : 'quiet — t opens its terminal')
      : row.running ? 'working' : row.awaiting ? inRow(row.awaiting) : '';
  const skills = (task.skills ?? []).join(' · ');
  const meta = [activity, runner, structured ? 'structured' : '', model].filter(Boolean).join(' · ');
  if (meta) lines.push(style.grey(truncate(`${bodyPad}${meta}`, cols)));
  if (skills) lines.push(style.grey(truncate(`${bodyPad}skills: ${skills}`, cols)));
  // Asked for structured and did not get it: said on the row, never silently.
  if (task.transport?.fallback) lines.push(style.yellow(truncate(`${bodyPad}terminal: ${task.transport.fallback}`, cols)));
  if (effort || mode) lines.push(style.grey(truncate(`${bodyPad}${[effort, mode].filter(Boolean).join(' · ')}`, cols)));
  // The one isolation state that needs the user; every other stays out of the
  // row and shows only in the expanded detail below.
  if (row.conflict) {
    const where = row.conflict.repo ? ` in ${row.conflict.repo}` : '';
    const files = row.conflict.files ? ` (${row.conflict.files})` : '';
    lines.push(style.red(truncate(`${bodyPad}⚠ merge conflict${where}${files} — its work is kept on its own branch`, cols)));
  }
  // `attempt` is absent only for a task shown straight from a reloaded plan,
  // before the live stream has caught up.
  if (row.repairing) {
    const files = row.repairing.files ? ` in ${row.repairing.files}` : '';
    const attempt = row.repairing.attempt ? ` (attempt ${row.repairing.attempt.attempt}/${row.repairing.attempt.limit})` : '';
    lines.push(style.yellow(truncate(`${bodyPad}↻ repairing conflict${files}${attempt}`, cols)));
  }
  // A merge gate holds the task as plainly as a task that waits on the user (ADR-0020).
  if (row.mergeGate) {
    lines.push(style.yellow(truncate(`${bodyPad}⏸ waits for Merge all — ${row.mergeGate.join(', ')} not merged into your branch yet`, cols)));
  }
  if (row.opsChangedFiles) {
    lines.push(style.yellow(truncate(`${bodyPad}⚠ an ops task changed tracked files — check them, then m done or /retry`, cols)));
  }
  if (row.repaired?.landed) {
    lines.push(style.grey(truncate(`${bodyPad}↻ landed after repairing conflict in ${row.repaired.files}`, cols)));
  }

  let editorLine: number | undefined;
  if (expanded) {
    lines.push(style.grey(`${bodyPad}${task.status.replace(/_/g, ' ')}`));
    if (task.isolation && task.isolation.state !== 'none' && task.isolation.branch) {
      lines.push(...taskText('Branch', task.isolation.branch, cols, bodyPad));
      if (row.repos.length > 0) lines.push(...taskText('Repos', row.repos.join(', '), cols, bodyPad));
      // An integrated task's worktree is gone; naming it would point at nothing.
      if (task.isolation.state !== 'integrated' && task.isolation.worktree) {
        lines.push(...taskText('Worktree', task.isolation.worktree, cols, bodyPad));
      }
    }
    if (row.kind === 'ops') {
      lines.push(...taskText('Ops', 'Runs in your checkout, not a worktree, once the work it depends on is merged. O makes it a change task.', cols, bodyPad));
    }
    if (row.forcedPastGate) {
      lines.push(...taskText('Forced', `Started before the work of ${row.forcedPastGate.join(', ')} was merged into your branch.`, cols, bodyPad));
    }
    if (row.autonomous) {
      lines.push(...taskText('Autonomy', 'Runs without permission prompts (Full). Change the level with /auto.', cols, bodyPad));
    }
    // The prompt editor is seeded from prompt ?? description ?? title, so only
    // show the static description when it carries information the editor won't.
    const editableSeed = task.prompt ?? task.description ?? task.title;
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
    // Two lines: the assignment keys plus the edit verbs no longer fit the plan
    // pane on one, and a truncated hint hides the keys it exists to teach. They
    // are named as what leaving the editor gets you, not as keys that work here
    // — while the prompt is open every letter types into it.
    lines.push(style.grey(`${bodyPad}enter save · esc cancel`));
    lines.push(style.grey(truncate(`${bodyPad}then R runner · o model · e effort · M mode · D deps · K skills`, cols)));
  }

  return { lines, editorLine };
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
      return `${pad}${line.slice(0, col)}${style.inverse(line.slice(col, col + 1) || ' ')}${line.slice(col + 1)}`;
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

/**
 * The command sheet, the rows of it that fit, and how far it scrolls. The sheet
 * is taller than most terminals, and it is the one overlay with an offset of
 * its own — so it needs the same exact bound the panes do.
 */
export interface HelpLayout {
  lines: string[];
  /** Rows of the sheet the frame can show at once. */
  room: number;
  maxScroll: number;
}

export function helpLayout(rows: number, cols: number): HelpLayout {
  const body: string[] = [];
  for (const [category, title] of Object.entries(CATEGORY_TITLE) as [SlashCategory, string][]) {
    const commands = SLASH_COMMANDS.filter((c) => c.category === category);
    if (commands.length === 0) continue;
    body.push(style.bold(title));
    for (const command of commands) {
      body.push(`  ${pad(command.usage, Math.min(38, cols - 6))} ${style.grey(command.description)}`);
    }
    body.push('');
  }
  body.push(
    style.grey('tab switches panes · pgup/pgdn scroll · ctrl-o toggles full detail · esc takes back a queued prompt, otherwise esc twice stops · ctrl-l clears · ctrl-c quits'),
  );
  // One line each: the sheet clips every line to the frame, and the task
  // view's keys run far past any width on a single one.
  body.push(
    '',
    style.bold('In a task view (t or /terminal on a structured task)'),
    style.grey('  ctrl-s sends now: interrupts the running step, then delivers the composer text — or, with it empty, the selected queued message'),
    style.grey('  ctrl-n/ctrl-p select a queued message · ctrl-r removes it · ctrl-x interrupts'),
    style.grey('  ctrl-y allows a tool request (its keys sit under it) · ctrl-t allows it for the task · ctrl-g denies it, with the composer text as the note'),
    style.grey('  at a checkpoint, ctrl-y approves and ctrl-g rejects, with the composer text as the reason · /checkpoint <id> approve|reject [reason] from anywhere'),
    style.grey('  alt←/→ changes attempt · esc returns'),
  );

  // The sheet is a table: clip long descriptions to one row each rather than
  // wrapping them, which would break the two-column alignment.
  const lines = body.map((line) => truncate(line, Math.max(1, cols - 2)));
  // One row for the frame's title, one for the sheet's own footer.
  const room = Math.max(1, rows - 2);
  return { lines, room, maxScroll: Math.max(0, lines.length - room) };
}

/** How far the help sheet can scroll at the size it is about to be painted. */
export function helpScrollMax(state: TuiState): number {
  return helpLayout(bodyRows(state), state.cols).maxScroll;
}
