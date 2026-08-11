import { pad, style, truncate, width, wrap, wrapLines, type WrapLine } from './ansi';
import { cursorInLines, type CursorPosition } from './editor';
import { renderMarkdown } from './markdown';
import { chatEditorRoom, chatPaneWidth, paneTextRoom, planPaneWidth } from './geometry';
import { SLASH_COMMANDS, type SlashCategory } from './slash';
import { isTaskRunning, type ChatMessage, type TaskView, type TuiState } from './state';
import { modesForTask } from './taskAssignment';
import { ALL_PROVIDERS, runnerForProvider, type AiProvider, type ResearchStepOutcome } from '@ordewell/core';

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
  return wrapLines(state.editor.text, chatEditorRoom(state.cols, true));
}

/**
 * The footer's key hints, unpainted. Kept next to the body extents because the
 * footer's height is what is left over for the body — the plan pane's list is
 * longer than a normal terminal is wide and routinely wraps to two rows.
 */
export function footerHints(state: TuiState): string[] {
  // `m` toggles, so the hint has to name the direction it will actually go for
  // the selected task — a fixed 'm done' on a finished task reads as a no-op.
  const markHint = state.tasks[state.selectedTask]?.status === 'completed' ? 'm undone' : 'm done';
  // A planning turn in flight owns ESC ahead of whatever the pane would
  // otherwise bind it to — the hint has to say so or the key isn't discoverable.
  const planning = state.status === 'planning' || state.status === 'researching';
  const escHint = planning ? 'esc stop planning' : null;

  if (state.focus === 'plan') {
    if (state.expandedTaskId) {
      return ['type to edit prompt', 'pgup/pgdn scroll', 'alt-enter newline', 'enter save', 'esc cancel'];
    }
    return [
      ...(escHint ? [escHint] : []),
      'enter expand', 'R runner', 'o model', 'e effort', 'M mode', 'D deps', 'f start',
      'E run plan', 'c cancel', markHint, 's skip', 'a add', 'd remove', 't terminal',
      'pgup/pgdn scroll', 'tab chat',
    ];
  }
  return [
    '/help', 'tab plan', 'alt-enter newline', 'pgup/pgdn scroll',
    ...(escHint ? [escHint] : []),
    'ctrl-c quit',
  ];
}

/**
 * Hints across as many lines as they need. The plan pane's list is longer than a
 * normal terminal is wide, and truncating it hid the very keys the footer exists
 * to teach — `t terminal` fell off the end as soon as two more were added.
 */
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

const ROLE_PREFIX: Record<ChatMessage['role'], (text: string) => string> = {
  user: (t) => `${style.cyan('❯')} ${t}`,
  assistant: (t) => `${style.magenta('◆')} ${t}`,
  system: (t) => style.grey(`· ${t}`),
  error: (t) => `${style.red('✗')} ${style.red(t)}`,
  // Research rows go through `researchRow`, which paints the outcome mark
  // separately; this entry only exists to keep the role map total.
  research: (t) => style.grey(`  ↳ ${t}`),
};

/**
 * How a research call ended, as one glyph. A refused `rm` and a successful
 * `rm` must not both read as a tick.
 */
const OUTCOME_MARK: Record<ResearchStepOutcome, string> = {
  success: '✓',
  failure: '✗',
  refused: '⊘',
  denied: '⊘',
  not_executed: '–',
};

/**
 * Only the mark carries colour. A dense run of successful reads stays as quiet
 * as the rest of the log, so a refusal or a failure is the thing that catches
 * the eye rather than one tick among thirty.
 */
const OUTCOME_PAINT: Record<ResearchStepOutcome, (text: string) => string> = {
  success: style.grey,
  failure: style.red,
  refused: style.yellow,
  denied: style.yellow,
  not_executed: style.grey,
};

const RESEARCH_RESULT_CHARS = 90;

export function researchLine(message: ChatMessage): string {
  const meta = message.research;
  if (!meta?.outcome) return `⋯ ${message.content}`;
  const result = (meta.result ?? '').replace(/\s+/g, ' ').trim();
  const preview = result.length > RESEARCH_RESULT_CHARS
    ? `${result.slice(0, RESEARCH_RESULT_CHARS)}…`
    : result;
  const mark = OUTCOME_MARK[meta.outcome];
  return preview ? `${mark} ${message.content} → ${preview}` : `${mark} ${message.content}`;
}

const RESEARCH_INDENT = '  ↳ ';

/**
 * One row per call, clipped rather than wrapped: a research log that wraps to
 * three rows per entry pushes the actual conversation off the pane.
 */
function researchRow(message: ChatMessage, cols: number): string {
  const text = truncate(researchLine(message), Math.max(1, cols - width(RESEARCH_INDENT)));
  const paint = OUTCOME_PAINT[message.research?.outcome ?? 'success'];
  const space = text.indexOf(' ');
  if (space < 0) return style.grey(`${RESEARCH_INDENT}${text}`);
  return `${style.grey('  ↳')} ${paint(text.slice(0, space))} ${style.grey(text.slice(space + 1))}`;
}

interface ChatBodyMemo {
  messages: ChatMessage[];
  cols: number;
  lines: string[];
}

// The transcript is the single most expensive thing to render — every
// assistant message is re-parsed (Markdown → string-width) each frame — but
// chat content is immutable once written: the reducer always hands back a new
// `messages` array on any change, and a spinner tick, a `status_update` flood
// or the user scrolling the plan pane never touch it. Memoising the wrapped
// lines on the array reference lets those renders skip the re-parse and just
// re-fit/scroll the cached body, which is what stops arrow-key scrolling on a
// task from lagging while a six-task plan runs. The body depends on nothing
// but `(messages, cols)`, so a single last-seen entry is all that can be reused
// — and it is why the reducer asks for its scroll bound at the same width the
// renderer will paint at, so the two of them share the one entry instead of
// evicting each other's.
let chatBodyMemo: ChatBodyMemo | null = null;

export function chatBodyLines(messages: ChatMessage[], cols: number): string[] {
  if (chatBodyMemo && chatBodyMemo.messages === messages && chatBodyMemo.cols === cols) {
    return chatBodyMemo.lines;
  }
  const lines: string[] = [];
  for (const message of messages) {
    // Research entries are a dense log; a blank line between each would push
    // the actual conversation off the top of the pane.
    if (message.role === 'research') {
      lines.push(researchRow(message, cols));
      continue;
    }
    const wrapped = message.role === 'assistant'
      ? renderMarkdown(message.content, Math.max(1, cols - 2))
      : wrap(message.content, Math.max(1, cols - 2));
    lines.push(...wrapped.map((line, i) => (i === 0 ? ROLE_PREFIX[message.role](line) : `  ${line}`)));
    lines.push('');
  }
  chatBodyMemo = { messages, cols, lines };
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
  anchor: 'top' | 'bottom';
  maxScroll: number;
}

export function chatLayout(state: TuiState, rows: number, cols: number): ChatLayout {
  // The welcome (logo, setup, hints) heads the transcript for the whole
  // planning conversation and only goes once a plan exists — from then on the
  // plan pane owns the screen and the chat column is too narrow for the art.
  const welcome = state.tasks.length === 0;
  if (welcome && state.messages.length === 0) {
    // Nothing has been said yet, so the welcome hangs off the top and stays
    // put; reporting any other bound would invent notches that do nothing.
    return { lines: welcomeLines(state, cols), anchor: 'top', maxScroll: 0 };
  }
  const body = chatBodyLines(state.messages, cols);
  const lines = welcome ? [...welcomeLines(state, cols), '', ...body] : body;
  return { lines, anchor: 'bottom', maxScroll: Math.max(0, lines.length - rows) };
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

const STATUS_MARK: Record<string, (text: string) => string> = {
  completed: style.green,
  running: style.yellow,
  in_progress: style.yellow,
  failed: style.red,
  blocked: style.red,
  awaiting_user: style.yellow,
  cancelled: style.grey,
  skipped: style.grey,
};

const STATUS_ICON: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  blocked: '!',
  awaiting_user: '?',
  cancelled: '−',
  skipped: '−',
  approved: '·',
  pending: '·',
};

/**
 * The plan pane's content and the two offsets that matter: where the viewport
 * sits when it is following the selection, and the furthest it may be pushed.
 * `lines[0]` is the header, which the pane pins — everything below it scrolls.
 */
export interface PlanLayout {
  lines: string[];
  /** Offset that keeps the selected task (or the open prompt's caret) on screen. */
  followOffset: number;
  maxScroll: number;
}

export function planLayout(state: TuiState, rows: number, cols: number): PlanLayout {
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  const lines = [style.bold(`Plan ${done}/${state.tasks.length}`), ''];

  // Track where the selected task actually lands — tasks are one line, or two
  // with an assigned model, so an estimate would scroll it out of view.
  let selectedLine = 2;
  // An expanded task starts its editor at the end of its prompt. For a long
  // prompt, keeping only the task heading visible makes edits appear to do
  // nothing because the caret is below the viewport.
  let editorLine: number | undefined;
  state.tasks.forEach((task, i) => {
    const taskStart = lines.length;
    if (i === state.selectedTask) selectedLine = taskStart;
    const renderedTask = taskLines(state, task, i, cols);
    if (task.id === state.expandedTaskId && renderedTask.editorLine !== undefined) {
      editorLine = taskStart + renderedTask.editorLine;
    }
    lines.push(...renderedTask.lines);
  });

  const maxScroll = Math.max(0, lines.length - rows);
  const anchorLine = editorLine ?? selectedLine;
  return { lines, followOffset: Math.min(maxScroll, Math.max(0, anchorLine - rows + 3)), maxScroll };
}

/**
 * Where the plan pane's viewport actually sits: the user's absolute offset,
 * clamped to what exists, or the follow anchor when they have not taken over.
 */
export function planOffset(layout: PlanLayout, planScroll: number | null): number {
  if (planScroll === null) return layout.followOffset;
  return Math.max(0, Math.min(layout.maxScroll, planScroll));
}

/** The plan pane's scroll geometry at the size it is about to be painted. */
export function planScrollExtent(state: TuiState): { followOffset: number; maxScroll: number } {
  const cols = planPaneWidth(state);
  // A pane too narrow to show has nothing to scroll; measuring it anyway would
  // wrap every title to a column and invent an offset the user can never see.
  if (cols === 0) return { followOffset: 0, maxScroll: 0 };
  const { followOffset, maxScroll } = planLayout(state, bodyRows(state), cols);
  return { followOffset, maxScroll };
}

interface TaskLines {
  lines: string[];
  /** The zero-based line within `lines` containing the prompt editor caret. */
  editorLine?: number;
}

function taskLines(state: TuiState, task: TaskView, index: number, cols: number): TaskLines {
  const selected = state.focus === 'plan' && index === state.selectedTask;
  const expanded = state.expandedTaskId === task.id;
  const running = isTaskRunning(task);
  const paint = STATUS_MARK[task.status] ?? ((t: string) => t);
  const rawIcon = running ? SPINNER[state.spinnerFrame % SPINNER.length] : (STATUS_ICON[task.status] ?? '·');
  const icon = paint(rawIcon);
  const kind = running
    ? style.yellow('RUN')
    : task.type === 'user'
      ? style.yellow('MAN')
      : style.grey(' AI');
  const caret = selected ? style.cyan('❯') : ' ';

  const head = `${caret} ${icon} ${String(task.order).padStart(2)} ${kind} `;
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
  // Autonomy is a manifest tag on the task's own mode, not a mode name — so this
  // looks the tag up rather than string-matching a mode id (ADR-0001: no
  // hardcoded mode names).
  const modeInfo = task.type === 'ai'
    ? modesForTask(state.modesByRunner, task).find((m) => m.id === task.taskMode)
    : undefined;
  const mode = task.type === 'ai'
    ? `mode: ${task.taskMode ?? 'default'}${modeInfo?.autonomous ? style.yellow(' ⚡') : ''}`
    : '';
  const runner = task.assignedRunner ?? '';
  const meta = [running ? 'working' : '', runner, model].filter(Boolean).join(' · ');
  if (meta) lines.push(style.grey(truncate(`    ${meta}`, cols)));
  if (effort || mode) lines.push(style.grey(truncate(`    ${[effort, mode].filter(Boolean).join(' · ')}`, cols)));

  let editorLine: number | undefined;
  if (expanded) {
    lines.push(style.grey(`    ${task.status.replace(/_/g, ' ')}`));
    if (modeInfo?.autonomous) {
      lines.push(...taskText('Autonomy', 'Runs without permission prompts. Toggle with /auto.', cols));
    }
    // The prompt editor is seeded from prompt ?? description ?? title, so only
    // show the static description when it carries information the editor won't.
    const editableSeed = task.prompt ?? task.description ?? task.title;
    if (task.description && task.description !== task.title && task.description !== editableSeed) {
      lines.push(...taskText('Description', task.description, cols));
    }
    if (state.taskEditor) {
      // Wrap the prompt once and derive both the caret's line (for scroll
      // anchoring) and the painted rows from it — a second `cursorPosition`
      // call would re-wrap the whole prompt every frame.
      const room = paneTextRoom(cols);
      const wrapped = wrapLines(state.taskEditor.text, room);
      const cp = cursorInLines(wrapped, state.taskEditor.cursor, state.taskEditor.text.length);
      editorLine = lines.length + 1 + cp.line;
      lines.push(...taskPromptLines(wrapped, cp));
    }
    if (task.dependencies.length > 0) {
      const orderById = new Map(state.tasks.map((candidate) => [candidate.id, candidate.order]));
      const dependencies = task.dependencies
        .map((id) => orderById.has(id) ? `#${orderById.get(id)}` : id)
        .join(', ');
      lines.push(...taskText('Depends on', dependencies, cols));
    }
    // Two lines: the assignment keys plus the edit verbs no longer fit the plan
    // pane on one, and a truncated hint hides the keys it exists to teach. They
    // are named as what leaving the editor gets you, not as keys that work here
    // — while the prompt is open every letter types into it.
    lines.push(style.grey('    enter save · esc cancel'));
    lines.push(style.grey(truncate('    then R runner · o model · e effort · M mode · D deps', cols)));
  }

  return { lines, editorLine };
}

function taskText(label: string, text: string, cols: number): string[] {
  const room = paneTextRoom(cols);
  return [
    style.grey(`    ${label}`),
    ...wrap(text, room).map((line) => `    ${line}`),
  ];
}

/** Paints an already-wrapped prompt with its caret. Indented to match taskText. */
function taskPromptLines(wrapped: WrapLine[], cursor: CursorPosition): string[] {
  return [
    style.grey('    Prompt'),
    ...wrapped.map(({ line }, i) => {
      if (i !== cursor.line) return `    ${line}`;
      const col = cursor.col;
      return `    ${line.slice(0, col)}${style.inverse(line.slice(col, col + 1) || ' ')}${line.slice(col + 1)}`;
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
    style.grey('tab switches panes · ↑↓/pgup/pgdn scroll · ctrl-l clears · ctrl-c quits'),
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
