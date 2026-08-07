import { pad, style, truncate, width, wrap } from './ansi';
import { cursorInLines } from './editor';
import { completions } from './slash';
import {
  bodyRows, chatInputWrap, chatLayout, footerHints, helpLayout, packHints, planLayout, planOffset,
} from './layout';
import { chatEditorRoom, chatPaneWidth, planPaneWidth } from './geometry';
import { SKILL_IDS, visibleItems, type PickerState, type TuiState } from './state';

/**
 * The whole frame as `state.rows` lines, each at most `state.cols` columns
 * wide. Pure: the driver just writes what comes back, which is what makes the
 * layout testable.
 *
 * What each pane's content *is* — and therefore how far it scrolls — belongs to
 * `layout.ts`, which the reducer reads too. This file paints, fits and joins.
 */
export function render(state: TuiState): string[] {
  const { rows, cols } = state;
  const rowsForBody = bodyRows(state);

  const body = state.overlay
    ? renderOverlay(state, rowsForBody, cols)
    : renderBody(state, rowsForBody, cols);

  const lines = [
    renderSkills(state, cols),
    ...body,
    renderStatus(state, cols),
    ...renderInput(state, cols),
    ...renderFooter(state, cols),
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

/**
 * A pane pinned away from its live tail with nothing saying so reads as broken,
 * which is the complaint that started all of this. It rides the status row
 * rather than the footer because that row is always exactly one line: a hint
 * that appeared and disappeared in the footer would change the body's height,
 * and a page notch measured from it would differ going up and coming back.
 */
function scrolledBackMark(state: TuiState): string {
  if (state.focus === 'plan') return state.planScroll === null ? '' : '↑ scrolled back · ↑↓ to follow';
  return state.scroll > 0 ? '↑ scrolled back · pgdn for live' : '';
}

function renderStatus(state: TuiState, cols: number): string {
  const mark = scrolledBackMark(state);
  if (state.status === 'idle') {
    const notes = [mark, state.toast].filter(Boolean).join(' · ');
    return notes ? truncate(style.grey(notes), cols) : '';
  }
  const scrolled = mark ? style.grey(`${mark} · `) : '';
  const label = state.busyLabel ? ` ${state.busyLabel}` : '';
  const verb = state.status === 'executing' ? 'Executing'
    : state.status === 'researching' ? 'Researching'
    : 'Planning';
  const head = scrolled + style.yellow(`● ${verb}…${label}`);
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
  const lines = chatInputWrap(state);
  const room = chatEditorRoom(cols, lines !== null);
  const { text, cursor } = state.editor;
  const continuation = ' '.repeat(width(prompt));

  // A blurred editor never wraps — a literal \n here would push every
  // following row down one line, so newlines/tabs are squashed to one row.
  if (!lines) {
    const visible = text.replace(/\n/g, '¶').replace(/\t/g, ' ');
    return [prompt + visible + suggest(state, room - width(visible))];
  }

  // The caret is derived from the same wrapped lines rather than re-wrapping,
  // which doubled the cost of every keystroke on a long input.
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
  return packHints(footerHints(state), cols).map((line) => truncate(style.grey(line), cols));
}

// ── Body ─────────────────────────────────────────────────────────────────────

function renderBody(state: TuiState, rows: number, cols: number): string[] {
  const planCols = planPaneWidth(state);
  if (planCols === 0) return renderChat(state, rows, cols);

  const chatCols = chatPaneWidth(state);
  const chat = renderChat(state, rows, chatCols);
  const plan = renderPlan(state, rows, planCols);

  return Array.from({ length: rows }, (_, i) =>
    `${pad(chat[i] ?? '', chatCols)}${style.grey('│')}${pad(plan[i] ?? '', planCols)}`,
  );
}

function renderChat(state: TuiState, rows: number, cols: number): string[] {
  // Newest content wins the available space; the top scrolls away — unless the
  // user paged back, in which case the view holds `scroll` lines off the tail.
  // The offset is already clamped where it is written, so the `min` here is a
  // belt against a resize that shrank the content under a live offset.
  const { lines, anchor, maxScroll } = chatLayout(state, rows, cols);
  const back = Math.min(state.scroll, maxScroll);
  return fit(lines.slice(0, lines.length - back), rows, anchor);
}

function renderPlan(state: TuiState, rows: number, cols: number): string[] {
  const layout = planLayout(state, rows, cols);
  const offset = planOffset(layout, state.planScroll);
  // The header is pinned; only what is under it scrolls.
  return fit([layout.lines[0], ...layout.lines.slice(1 + offset)], rows, 'top');
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

function renderHelp(scroll: number, rows: number, cols: number): string[] {
  const { lines, room, maxScroll } = helpLayout(rows, cols);
  const offset = Math.min(scroll, maxScroll);
  const footer = style.grey(offset < maxScroll ? '↑↓ scroll · any other key closes' : 'any key closes');

  return frame('Commands', [...lines.slice(offset, offset + room), footer], rows, cols);
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
