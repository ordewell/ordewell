import { pad, style, truncate, width, wrap, wrapLines, type WrapLine } from './ansi';
import { cursorInLines, type CursorPosition } from './editor';
import { renderMarkdown } from './markdown';
import { completions, SLASH_COMMANDS, type SlashCategory } from './slash';
import { visibleItems } from './reducer';
import { chatEditorRoom, paneTextRoom, planPaneWidth } from './geometry';
import { isTaskRunning, SKILL_IDS, type ChatMessage, type PickerState, type TaskView, type TuiState } from './state';
import { ALL_PROVIDERS, runnerForProvider, type AiProvider, type ResearchStepOutcome } from '@ordewell/core';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** skills, status, input, footer — everything that is not the body. */
const CHROME_ROWS = 4;

/**
 * The whole frame as `state.rows` lines, each at most `state.cols` columns
 * wide. Pure: the driver just writes what comes back, which is what makes the
 * layout testable.
 */
export function render(state: TuiState): string[] {
  const { rows, cols } = state;
  const input = renderInput(state, cols);
  const footer = renderFooter(state, cols);
  const bodyRows = Math.max(0, rows - CHROME_ROWS - input.length - footer.length + 2);

  const body = state.overlay
    ? renderOverlay(state, bodyRows, cols)
    : renderBody(state, bodyRows, cols);

  const lines = [
    renderSkills(state, cols),
    ...body,
    renderStatus(state, cols),
    ...input,
    ...footer,
  ];

  // Chrome is dropped from the top down in a terminal too short to hold it.
  return lines.slice(Math.max(0, lines.length - rows)).map((l) => pad(l, cols));
}

/** Exactly `rows` lines. Chat sticks to the bottom; panels fill downwards. */
function fit(lines: string[], rows: number, anchor: 'top' | 'bottom'): string[] {
  if (lines.length >= rows) {
    return anchor === 'bottom' ? lines.slice(lines.length - rows) : lines.slice(0, rows);
  }
  const blanks = Array(rows - lines.length).fill('');
  return anchor === 'bottom' ? [...blanks, ...lines] : [...lines, ...blanks];
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function renderSkills(state: TuiState, cols: number): string {
  const badges = SKILL_IDS.map((id) =>
    state.skills[id] ? style.green(`● ${id}`) : style.grey(`○ ${id}`),
  );
  const auto = state.autonomous ? style.yellow('● auto') : style.grey('○ auto');
  return truncate([...badges, auto].join(' '), cols);
}

function renderStatus(state: TuiState, cols: number): string {
  if (state.status === 'idle') {
    return state.toast ? truncate(style.grey(state.toast), cols) : '';
  }
  const label = state.busyLabel ? ` ${state.busyLabel}` : '';
  const verb = state.status === 'executing' ? 'Executing'
    : state.status === 'researching' ? 'Researching'
    : 'Planning';
  const head = style.yellow(`● ${verb}…${label}`);
  // The planner's reasoning shares the status row rather than the transcript:
  // it arrives as a token stream and would otherwise bury the tool log.
  const thinking = state.thinkingLine.replace(/\s+/g, ' ').trim();
  if (!thinking) return truncate(head, cols);
  const room = cols - width(head) - 3;
  if (room < 12) return truncate(head, cols);
  // The tail is a slice out of a live stream, so it starts mid-word; the
  // leading ellipsis says so instead of reading as a sentence that begins there.
  const tail = thinking.length > room ? `…${thinking.slice(-(room - 1)).trimStart()}` : thinking;
  return truncate(`${head}${style.grey(` · ${tail}`)}`, cols);
}

function renderInput(state: TuiState, cols: number): string[] {
  const prompt = state.focus === 'plan' ? style.grey('❯ ') : style.cyan('❯ ');
  // The driver hides the hardware cursor, so the frame marks the caret itself —
  // but only while keystrokes actually go to the editor.
  const active = state.focus === 'chat' && !state.overlay;
  const room = chatEditorRoom(cols, active);
  const { text, cursor } = state.editor;
  const continuation = ' '.repeat(width(prompt));

  // A blurred editor never wraps — a literal \n here would push every
  // following row down one line, so newlines/tabs are squashed to one row.
  if (!active) {
    const visible = text.replace(/\n/g, '¶').replace(/\t/g, ' ');
    return [prompt + visible + suggest(state, room - width(visible))];
  }

  // Wrap once; the caret is derived from the same wrapped lines rather than
  // re-wrapping, which doubled the cost of every keystroke on a long input.
  const lines = wrapLines(text, room);
  const { line: lineIndex, col } = cursorInLines(lines, cursor, text.length);
  const rawLines = lines.map((l) => l.line);

  return rawLines.map((raw, i) => {
    const prefix = i === 0 ? prompt : continuation;
    const line = raw.replace(/\t/g, ' ');
    const isCursorLine = i === lineIndex;
    const rendered = isCursorLine
      ? line.slice(0, col) + style.inverse(line.slice(col, col + 1) || ' ') + line.slice(col + 1)
      : line;
    const used = width(line) + (isCursorLine && col >= line.length ? 1 : 0);
    const hint = i === rawLines.length - 1 ? suggest(state, room - used) : '';
    return prefix + rendered + hint;
  });
}

/** Inline hint of the first matching command, shown while typing a `/`. */
function suggest(state: TuiState, room: number): string {
  if (state.focus === 'plan' || room <= 2) return '';
  const matches = completions(state.editor.text);
  if (matches.length === 0) return '';
  const names = matches.map((c) => c.name).join(' ');
  return style.grey(`  ${truncate(names, Math.max(0, room - 2))}`);
}

function renderFooter(state: TuiState, cols: number): string[] {
  // `m` toggles, so the hint has to name the direction it will actually go for
  // the selected task — a fixed 'm done' on a finished task reads as a no-op.
  const markHint = state.tasks[state.selectedTask]?.status === 'completed' ? 'm undone' : 'm done';
  // A planning turn in flight owns ESC ahead of whatever the pane would
  // otherwise bind it to — the hint has to say so or the key isn't discoverable.
  const planning = state.status === 'planning' || state.status === 'researching';
  const escHint = planning ? 'esc stop planning' : null;
  const hints =
    state.focus === 'plan'
      ? state.expandedTaskId
        ? ['type to edit prompt', 'pgup/pgdn scroll', 'alt-enter newline', 'enter save', 'esc cancel']
        : [
            ...(escHint ? [escHint] : []),
            'enter expand', 'R runner', 'o model', 'e effort', 'M mode', 'D deps', 'f start',
            'E run plan', 'c cancel', markHint, 's skip', 'a add', 'd remove', 't terminal',
            'pgup/pgdn scroll', 'tab chat',
          ]
      : [
          '/help', 'tab plan', 'alt-enter newline', 'pgup/pgdn scroll',
          ...(escHint ? [escHint] : []),
          'ctrl-c quit',
        ];
  return packHints(hints, cols);
}

/**
 * Hints across as many lines as they need. The plan pane's list is longer than a
 * normal terminal is wide, and truncating it hid the very keys the footer exists
 * to teach — `t terminal` fell off the end as soon as two more were added.
 */
function packHints(hints: string[], cols: number): string[] {
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
  return lines.map((line) => truncate(style.grey(line), cols));
}

// ── Body ─────────────────────────────────────────────────────────────────────

function renderBody(state: TuiState, rows: number, cols: number): string[] {
  const planCols = planPaneWidth(state);
  if (planCols === 0) return renderChat(state, rows, cols);

  const chatCols = cols - planCols - 1;
  const chat = renderChat(state, rows, chatCols);
  const plan = renderPlan(state, rows, planCols);

  return Array.from({ length: rows }, (_, i) =>
    `${pad(chat[i] ?? '', chatCols)}${style.grey('│')}${pad(plan[i] ?? '', planCols)}`,
  );
}

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
// but `(messages, cols)`, so a single last-seen entry is all that can be reused.
let chatBodyMemo: ChatBodyMemo | null = null;

/** @internal Exposed for the memo test; production calls go through `render`. */
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

function renderChat(state: TuiState, rows: number, cols: number): string[] {
  // The welcome (logo, setup, hints) heads the transcript for the whole
  // planning conversation and only goes once a plan exists — from then on the
  // plan pane owns the screen and the chat column is too narrow for the art.
  const welcome = state.tasks.length === 0;
  if (welcome) {
    const lines = [...renderWelcome(state, cols), ''];
    if (state.messages.length === 0) return fit(lines.slice(0, -1), rows, 'top');
    lines.push(...chatBodyLines(state.messages, cols));
    const back = Math.min(state.scroll, Math.max(0, lines.length - rows));
    return fit(lines.slice(0, lines.length - back), rows, 'bottom');
  }
  // Newest content wins the available space; the top scrolls away — unless the
  // user paged back, in which case the view holds `scroll` lines off the tail.
  const lines = chatBodyLines(state.messages, cols);
  const back = Math.min(state.scroll, Math.max(0, lines.length - rows));
  return fit(lines.slice(0, lines.length - back), rows, 'bottom');
}

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

function renderBanner(rows: number, cols: number): string[] {
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

function renderWelcome(state: TuiState, cols: number): string[] {
  const planner = plannerSetup(state);
  const enabledRunners = state.runners.filter((r) => r.enabled).map((r) => r.name);
  const canPlan = planner.ready
    || state.runners.length > 0
    || state.configuredProviders.length > 0;

  const plannerValue = planner.ready
    ? [planner.label, state.orchestratorModel || style.yellow('no model')].join(style.grey(' · '))
    : style.yellow(planner.label === 'not set' ? 'not set' : `${planner.label} (unavailable)`);

  const lines = [
    ...renderBanner(state.rows, cols),
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

function renderPlan(state: TuiState, rows: number, cols: number): string[] {
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  const header = style.bold(`Plan ${done}/${state.tasks.length}`);
  const lines = [header, ''];

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
    const renderedTask = renderTask(state, task, i, cols);
    if (task.id === state.expandedTaskId && renderedTask.editorLine !== undefined) {
      editorLine = taskStart + renderedTask.editorLine;
    }
    lines.push(...renderedTask.lines);
  });

  // Keep the selected task in view as the plan grows past the pane.
  const overflow = Math.max(0, lines.length - rows);
  const anchorLine = editorLine ?? selectedLine;
  const scroll = Math.min(overflow, Math.max(0, anchorLine - rows + 3));
  const totalScroll = Math.min(overflow, scroll + state.planScroll);

  return fit([lines[0], ...lines.slice(1 + totalScroll)], rows, 'top');
}

interface RenderedTask {
  lines: string[];
  /** The zero-based line within `lines` containing the prompt editor caret. */
  editorLine?: number;
}

function renderTask(state: TuiState, task: TaskView, index: number, cols: number): RenderedTask {
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
  const mode = task.type === 'ai' ? `mode: ${task.taskMode ?? 'default'}` : '';
  const runner = task.assignedRunner ?? '';
  const meta = [running ? 'working' : '', runner, model].filter(Boolean).join(' · ');
  if (meta) lines.push(style.grey(truncate(`    ${meta}`, cols)));
  if (effort || mode) lines.push(style.grey(truncate(`    ${[effort, mode].filter(Boolean).join(' · ')}`, cols)));

  let editorLine: number | undefined;
  if (expanded) {
    lines.push(style.grey(`    ${task.status.replace(/_/g, ' ')}`));
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
      lines.push(...renderTaskPrompt(wrapped, cp));
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
function renderTaskPrompt(wrapped: WrapLine[], cursor: CursorPosition): string[] {
  return [
    style.grey('    Prompt'),
    ...wrapped.map(({ line }, i) => {
      if (i !== cursor.line) return `    ${line}`;
      const col = cursor.col;
      return `    ${line.slice(0, col)}${style.inverse(line.slice(col, col + 1) || ' ')}${line.slice(col + 1)}`;
    }),
  ];
}

// ── Overlays ─────────────────────────────────────────────────────────────────

function renderOverlay(state: TuiState, rows: number, cols: number): string[] {
  const overlay = state.overlay!;
  if (overlay.kind === 'help') return renderHelp(overlay.scroll ?? 0, rows, cols);
  if (overlay.kind === 'approval') {
    const { request } = overlay;
    const headline = request.kind === 'shell_command'
      ? 'The planner wants to run a command'
      : request.kind === 'url_fetch'
        ? 'The planner wants to fetch a URL'
        : 'The planner wants to read a path outside the workspace';
    const queued = state.pendingApprovals.length;

    return frame(
      'Approval needed',
      [
        headline,
        '',
        `  ${style.yellow(request.subject)}`,
        '',
        // Disambiguates the `external_path` case: an auto-tier command like
        // `cat` touching an outside path reads identically to a plain
        // `read_file` without it.
        ...(request.detail ? [style.grey(request.detail), ''] : []),
        // The grant is wider than the request, so name it rather than letting
        // the user discover it when the next call silently does not prompt.
        style.grey(`Approving also allows ${request.scope} for the rest of this session.`),
        ...(queued > 0 ? [style.grey(`${queued} more waiting.`)] : []),
        '',
        style.grey('y or enter allows · n or esc denies'),
      ],
      rows,
      cols,
    );
  }
  if (overlay.kind === 'confirm') {
    return frame(
      overlay.title,
      [overlay.message, '', style.grey('enter confirms · esc cancels')],
      rows,
      cols,
    );
  }
  if (overlay.kind === 'prompt') {
    // API keys are secrets — never echo one to a screen that may be shared.
    const secret = overlay.action.kind === 'api-key';
    const shown = secret ? '•'.repeat(overlay.value.length) : overlay.value;
    return frame(
      overlay.title,
      [overlay.hint ? style.grey(overlay.hint) : '', '', `${style.cyan('❯')} ${shown}`, '', style.grey('enter confirms · esc cancels')],
      rows,
      cols,
    );
  }
  return renderPicker(overlay.picker, rows, cols);
}

function renderPicker(picker: PickerState, rows: number, cols: number): string[] {
  const items = visibleItems(picker);
  const body: string[] = [];

  if (picker.hint) body.push(style.grey(picker.hint));
  body.push(`${style.grey('filter:')} ${picker.filter}${style.grey('▏')}`, '');

  if (items.length === 0) {
    body.push(style.grey(picker.filter ? 'Nothing matches that filter.' : 'Nothing to show yet…'));
  }

  // Scroll the list so the highlighted row stays on screen.
  const room = Math.max(1, rows - body.length - 3);
  const start = Math.max(0, Math.min(picker.index - Math.floor(room / 2), items.length - room));

  for (const [offset, item] of items.slice(start, start + room).entries()) {
    const active = start + offset === picker.index;
    const mark = picker.multi
      ? (picker.chosen.includes(item.id) ? style.green('[✓]') : style.grey('[ ]'))
      : item.selected
        ? style.green('●')
        : ' ';
    // Spaced off the caret on purpose: `❯●` reads as one smudged glyph.
    const caret = active ? style.cyan('❯') : ' ';
    const label = truncate(item.label, Math.max(1, cols - 12));
    const detail = item.detail ? style.grey(` — ${item.detail}`) : '';
    // An unavailable row (a coding agent whose CLI is missing) is greyed whole
    // rather than hidden, so the reason in `detail` stays legible.
    const line = item.disabled
      ? `${caret} ${mark} ${style.grey(label)}${detail}`
      : `${caret} ${mark} ${active ? style.bold(label) : label}${detail}`;
    body.push(truncate(line, cols - 2));
  }

  body.push('', style.grey(picker.multi
    ? 'space toggles · enter confirms · esc cancels · type to filter'
    : 'enter selects · esc cancels · type to filter'));
  return frame(picker.title, body, rows, cols);
}

const CATEGORY_TITLE: Record<SlashCategory, string> = {
  planning: 'Planning',
  tasks: 'Tasks',
  models: 'Models & providers',
  skills: 'Skills',
  session: 'Sessions',
  system: 'System',
};

function renderHelp(scroll: number, rows: number, cols: number): string[] {
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
  const wrapped = body.map((line) => truncate(line, Math.max(1, cols - 2)));
  const room = Math.max(1, rows - 2);
  const max = Math.max(0, wrapped.length - room);
  const offset = Math.min(scroll, max);
  const footer = style.grey(offset < max ? '↑↓ scroll · any other key closes' : 'any key closes');

  return frame('Commands', [...wrapped.slice(offset, offset + room), footer], rows, cols);
}

/** A titled box the width of the pane, padded or clipped to exactly `rows`. */
function frame(title: string, body: string[], rows: number, cols: number): string[] {
  const inner = Math.max(1, cols - 2);
  const lines = [
    style.grey(`┌─ ${style.bold(title)} ${'─'.repeat(Math.max(0, inner - width(title) - 3))}`),
    ...body.flatMap((line) => wrap(line, inner)).map((line) => ` ${truncate(line, inner)}`),
  ];
  return fit(lines, rows, 'top');
}
