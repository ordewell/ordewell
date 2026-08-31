import { pad, stripAnsi, style, truncate, width, wrap } from './ansi';
import { cursorInLines } from './editor';
import { activeToken, skillMatchKind, slashTokens, tokenCompletions } from './slash';
import {
  bodyRows, chatInputWrap, chatLayout, footerHints, helpLayout, packHints, planLayout, planOffset,
} from './layout';
import { chatEditorRoom, chatPaneWidth, paneColumns, planPaneWidth } from './geometry';
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
  const frame = lines.slice(Math.max(0, lines.length - rows)).map((l) => pad(l, cols));
  return highlightSelection(frame, state);
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * One painted row of a selection: the frame row it covers and the inclusive,
 * 1-based screen columns of it that are selected.
 */
interface SelectionSpan {
  row: number;
  from: number;
  to: number;
}

/**
 * The selection as painted rows. Both ends are inclusive, and every row between
 * the first and the last takes the *whole* of its pane — never the whole
 * terminal, which is the splice this exists to prevent.
 */
function selectionSpans(state: TuiState): SelectionSpan[] {
  const { selection } = state;
  if (!selection) return [];
  const { anchor, head } = selection;
  const forwards = anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col);
  const [start, end] = forwards ? [anchor, head] : [head, anchor];
  const { first, last } = paneColumns(state, selection.pane);

  const spans: SelectionSpan[] = [];
  for (let row = start.row; row <= end.row; row++) {
    spans.push({
      row,
      from: row === start.row ? start.col : first,
      to: row === end.row ? end.col : last,
    });
  }
  return spans;
}

/**
 * A rendered row as one entry per screen column. A double-width glyph owns the
 * first of the two columns it covers and leaves the second empty, so slicing
 * this array by column can never cut a cluster in half or shift what follows.
 * Paint is dropped: this is the text under the columns, not how it looks.
 */
function cells(line: string): string[] {
  const out: string[] = [];
  for (const char of stripAnsi(line)) {
    out.push(char);
    for (let i = 1; i < Math.max(1, width(char)); i++) out.push('');
  }
  return out;
}

// Inverse video on, and off *without* a reset. `style.inverse` closes with
// SGR 0, which would drop whatever colour the row had open around the
// selection; SGR 27 clears only the inverse bit and leaves the rest standing.
const INVERSE_ON = '\x1b[7m';
const INVERSE_OFF = '\x1b[27m';
// Capturing, so `split` hands back the escapes along with the text between
// them — the row is walked once rather than re-scanned per character. Wider
// than SGR because a body row also carries the divider's anchor.
// eslint-disable-next-line no-control-regex
const ESCAPE_SPLIT = /(\x1b\[[0-9;]*[A-Za-z])/;
// eslint-disable-next-line no-control-regex
const CURSOR_COLUMN = /^\x1b\[([0-9]*)G$/;

/**
 * One row with `from`..`to` (inclusive, 1-based) inverted.
 *
 * Only SGR sequences are added, and `width()` measures a row with those
 * stripped — so the row's measured width, and with it the pane divider's
 * column, comes out exactly as it went in. That matters more here than it
 * looks: a row that measures wider than `cols` is what `clampToCols` chops and
 * what AUTOWRAP_OFF exists to stop from shoving every row below it down one
 * line (see terminal.ts).
 *
 * Inverse is re-asserted after any escape already in the row, because a `\x1b[0m`
 * the row closes its own colour with would otherwise end the highlight early.
 */
function invertCells(line: string, from: number, to: number): string {
  let out = '';
  let col = 1;
  let inside = false;

  for (const piece of line.split(ESCAPE_SPLIT)) {
    if (ESCAPE_SPLIT.test(piece)) {
      // The divider's anchor decides where the next character lands, so the
      // walk follows it — otherwise every column past the divider would be
      // counted from wherever the chat side happened to end.
      const jump = CURSOR_COLUMN.exec(piece);
      if (jump) col = Number(jump[1] || '1');
      out += piece + (inside ? INVERSE_ON : '');
      continue;
    }
    for (const char of piece) {
      if (inside && col > to) {
        out += INVERSE_OFF;
        inside = false;
      } else if (!inside && col >= from && col <= to) {
        out += INVERSE_ON;
        inside = true;
      }
      out += char;
      col += Math.max(1, width(char));
    }
  }

  return inside ? out + INVERSE_OFF : out;
}

/** The frame with the selected cells inverted. Untouched when nothing is selected. */
function highlightSelection(frame: string[], state: TuiState): string[] {
  if (!state.selection || !style.enabled) return frame;
  const painted = [...frame];
  for (const { row, from, to } of selectionSpans(state)) {
    const line = painted[row - 1];
    if (line !== undefined) painted[row - 1] = invertCells(line, from, to);
  }
  return painted;
}

/**
 * The selected text, ready for the clipboard: each row clipped to its pane's
 * columns, paint stripped, and the padding every frame row is filled out with
 * trimmed off the end. Empty when nothing is selected.
 */
export function selectedText(state: TuiState): string {
  const spans = selectionSpans(state);
  if (spans.length === 0) return '';
  const frame = render(state);
  return spans
    .map(({ row, from, to }) => cells(frame[row - 1] ?? '').slice(from - 1, to).join('').replace(/\s+$/, ''))
    .join('\n');
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

/**
 * Cyan-highlight ranges (absolute offsets into the input) for every `/word`
 * token that could resolve to a *discovered* skill — a live,
 * character-by-character prefix match while composing, not just an exact
 * name, and never a built-in (those keep their plain styling). Trailing
 * punctuation on a token is left uncoloured even when the name before it
 * matches, mirroring how resolveSkillInvocation keeps it outside the splice.
 * A skill name repeated verbatim only highlights its first occurrence —
 * resolveSkillInvocation only expands that one, so nothing here should look
 * "recognized" that substitution then leaves untouched.
 */
function highlightSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const expandedExact = new Set<string>();
  for (const token of slashTokens(text)) {
    const kind = skillMatchKind(token.name);
    if (kind === null) continue;
    if (kind === 'exact') {
      if (expandedExact.has(token.name)) continue;
      expandedExact.add(token.name);
    }
    spans.push({ start: token.start, end: token.nameEnd });
  }
  return spans;
}

/**
 * `text` is the slice of the full input starting at column `base`. Any part
 * of it inside one of `spans` (absolute offsets into the full input) is
 * painted; the rest passes through untouched. Splitting after slicing —
 * rather than colouring the whole line up front — keeps every existing
 * index (`col`, `line.slice(...)`) counting plain characters, so the caret
 * math above is never asked to account for inserted escape codes.
 */
function paintSpans(text: string, base: number, spans: Array<{ start: number; end: number }>): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const localStart = Math.max(cursor, Math.min(text.length, span.start - base));
    const localEnd = Math.max(0, Math.min(text.length, span.end - base));
    if (localEnd <= localStart) continue;
    out += text.slice(cursor, localStart) + style.cyan(text.slice(localStart, localEnd));
    cursor = localEnd;
  }
  return out + text.slice(cursor);
}

function renderInput(state: TuiState, cols: number): string[] {
  const prompt = state.focus === 'plan' ? style.grey('❯ ') : style.cyan('❯ ');
  // The driver hides the hardware cursor, so the frame marks the caret itself —
  // but only while keystrokes actually go to the editor.
  const lines = chatInputWrap(state);
  const room = chatEditorRoom(cols, lines !== null);
  const { text, cursor } = state.editor;
  const continuation = ' '.repeat(width(prompt));
  const spans = highlightSpans(text);

  // A blurred editor never wraps — a literal \n here would push every
  // following row down one line, so newlines/tabs are squashed to one row.
  if (!lines) {
    const visible = text.replace(/\n/g, '¶').replace(/\t/g, ' ');
    const painted = paintSpans(visible, 0, spans);
    return [prompt + painted + suggest(state, room - width(visible))];
  }

  // The caret is derived from the same wrapped lines rather than re-wrapping,
  // which doubled the cost of every keystroke on a long input.
  const { line: lineIndex, col } = cursorInLines(lines, cursor, text.length);

  return lines.map(({ line: raw, start: base }, i) => {
    const prefix = i === 0 ? prompt : continuation;
    const line = raw.replace(/\t/g, ' ');
    const isCursorLine = i === lineIndex;
    if (!isCursorLine) return prefix + paintSpans(line, base, spans);

    const before = paintSpans(line.slice(0, col), base, spans);
    const caretChar = line.slice(col, col + 1) || ' ';
    const after = paintSpans(line.slice(col + 1), base + col + 1, spans);
    // The suggestion hint sits right after the caret — where the token being
    // composed actually is — rather than always at the end of the row, so it
    // still lands next to a `/skill` typed mid-sentence.
    const used = width(line.slice(0, col)) + width(caretChar);
    const hint = suggest(state, room - used);
    return prefix + before + style.inverse(caretChar) + hint + after;
  });
}

/** Inline hint of matching commands, shown right after a `/word` being actively typed. */
function suggest(state: TuiState, room: number): string {
  if (state.focus === 'plan' || room <= 2) return '';
  const token = activeToken(state.editor.text, state.editor.cursor);
  if (!token) return '';
  const matches = tokenCompletions(token);
  if (matches.length === 0) return '';
  const names = matches.map((c) => c.name).join(' ');
  return style.grey(`  ${truncate(names, Math.max(0, room - 2))}`);
}

function renderFooter(state: TuiState, cols: number): string[] {
  return packHints(footerHints(state), cols).map((line) => truncate(style.grey(line), cols));
}

// ── Body ─────────────────────────────────────────────────────────────────────

// Erase to end of line, then put the cursor on an absolute column of the row it
// is already on. Both are width-zero to `width()` — `stripAnsi` drops every
// escape sequence, not only colour — so a row carrying them still measures, and
// still slices for selection, exactly as the text alone would.
const ERASE_TO_END = '\x1b[K';
const atColumn = (col: number): string => `\x1b[${col}G`;

/**
 * The two panes and the divider between them.
 *
 * The divider is *anchored* to its column rather than assumed to land there.
 * `width()` is this package's best guess at how many columns the terminal will
 * spend on the chat side, and a guess is all it can be: an emoji, a ZWJ family,
 * a flag or a CJK cluster the terminal measures differently is a guess that is
 * wrong, and the divider — with the whole plan pane behind it — slides right by
 * the difference. That is the pane splice this is here to make impossible.
 *
 * So the row says where the divider goes instead of counting on the chat side
 * to end there: erase whatever the chat side left across the rest of the row,
 * jump to the divider's column, paint from there. An over-running chat row is
 * overwritten, an under-running one leaves no debris, and either way the plan
 * pane starts on the column it owns.
 */
function renderBody(state: TuiState, rows: number, cols: number): string[] {
  const planCols = planPaneWidth(state);
  if (planCols === 0) return renderChat(state, rows, cols);

  const chatCols = chatPaneWidth(state);
  const chat = renderChat(state, rows, chatCols);
  const plan = renderPlan(state, rows, planCols);
  const divider = `${ERASE_TO_END}${atColumn(chatCols + 1)}${style.grey('│')}`;

  return Array.from({ length: rows }, (_, i) =>
    `${pad(chat[i] ?? '', chatCols)}${divider}${pad(plan[i] ?? '', planCols)}`,
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
        // ESC is not "deny" while a turn is in flight — it kills the turn and
        // takes this prompt with it. Offering it as the deny key there would
        // teach the wrong thing about the most destructive key on the sheet.
        style.grey(state.status === 'planning' || state.status === 'researching'
          ? 'y or enter allows · n denies · esc stops planning'
          : 'y or enter allows · n or esc denies'),
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
