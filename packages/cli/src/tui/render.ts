import { firstGrapheme, graphemes, pad, sanitize, stripAnsi, style, truncate, width, wrap } from './ansi';
import { cursorInLines } from './editor';
import { activeToken, composerCompletions, runnerCommandFor, skillMatchKind, slashTokens } from './slash';
import {
  approvalLayout, bodyPanes, bodyRows, composerView, selectionArea, selectionColumns, chatLayout, footerHints, helpLayout, type HelpSheet, packHints, planLayout, planOffset,
  stopHint,
  chatActivity,
  runnerStoppable,
  SPINNER,
  QUIET_MARK,
  runHint,
  type BodyPanes,
  type ComposerView,
} from './layout';
import { chatEditorRoomFor, chatPromptLabel } from './geometry';
import { currentHandoff, diffRoom, handoffActions } from './handoff';
import { capConflictFiles, elapsedSince, handoffBaseLine, handoffBranchName, isRepoGroup, repoResultLines, taskLogCommands, titledTaskRef, titledTaskRefOf, type RunnerCommand } from '@ordewell/core';
import { matchingItems, scriptTaskView, visibleItems, type Overlay, type PickerItem, type PickerState, type TuiState } from './state';
import type { StepperState } from './reducers/stepper';
import { SUPERVISOR_LEVEL_LABEL } from '@ordewell/core';

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
  // Measured once per frame: stacked, it costs a pass over both panes' content.
  const panes = bodyPanes(state);

  const body = state.overlay
    ? renderOverlay(state, rowsForBody, cols)
    : renderBody(state, panes);

  const lines = [
    ...body,
    renderStatus(state, cols, panes),
    ...renderInput(state),
    ...renderFooter(state, cols),
  ];

  // Chrome is dropped from the top down in a terminal too short to hold it.
  const frame = lines.slice(Math.max(0, lines.length - rows)).map((l) => pad(l, cols));
  return highlightSelection(frame, state, panes);
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

const clampCol = (col: number, firstCol: number, lastCol: number): number =>
  Math.max(firstCol, Math.min(lastCol, col));

/**
 * The selection as painted rows. Both ends are inclusive, and every row between
 * the first and the last takes the *whole* of its region's width — a pane's,
 * never the terminal's, which is the splice this exists to prevent, while the
 * chrome under the body takes the whole frame. The rows themselves are pulled
 * into that region too, so a selection a resize or a stale report left past it
 * paints and copies nothing of the neighbour.
 */
function selectionSpans(state: TuiState, panes: BodyPanes): SelectionSpan[] {
  const { selection } = state;
  if (!selection) return [];
  const { anchor, head } = selection;
  const forwards = anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col);
  const [start, end] = forwards ? [anchor, head] : [head, anchor];
  const area = selectionArea(state, selection.pane, anchor.row, panes);

  const spans: SelectionSpan[] = [];
  const firstRow = Math.max(start.row, area.firstRow);
  const lastRow = Math.min(end.row, area.lastRow);
  for (let row = firstRow; row <= lastRow; row++) {
    const { firstCol, lastCol } = selectionColumns(area, row);
    spans.push({
      row,
      from: row === start.row ? clampCol(start.col, firstCol, lastCol) : firstCol,
      to: row === end.row ? clampCol(end.col, firstCol, lastCol) : lastCol,
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
  for (const char of graphemes(stripAnsi(line))) {
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
    for (const char of graphemes(piece)) {
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
function highlightSelection(frame: string[], state: TuiState, panes: BodyPanes): string[] {
  if (!state.selection || !style.enabled) return frame;
  const painted = [...frame];
  for (const { row, from, to } of selectionSpans(state, panes)) {
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
  const spans = selectionSpans(state, bodyPanes(state));
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

/**
 * Autonomy and the run settings (ADR-0030), shown at all times, since a global
 * setting that applies at once is the kind that is forgotten while it is on —
 * except on the bare welcome, whose Setup block already lists them. During a
 * run, the run's own level where a guard, a failure or another session left it
 * different from the setting.
 */
function settingsBadge(state: TuiState): string {
  if (!state.taskView && state.tasks.length === 0 && state.conversation.blocks.length === 0) return '';
  const auto = state.autonomous ? style.yellow('● Full') : style.green('● Guarded');
  return `${auto}${style.grey(' · ')}${runSettingsBadge(state)}`;
}

function runSettingsBadge(state: TuiState): string {
  if (!state.runSettingsKnown) return style.grey('run settings …');
  const { supervisorLevel, mergeAtGatesAutomatically, autorun } = state.runSettings;
  const paint = (text: string, warn: boolean) => (warn ? style.yellow(text) : style.grey(text));
  const run = state.status === 'executing' ? state.runSupervisor : null;
  const actual = run?.unsupervised ? 'unsupervised' : run && run.level !== supervisorLevel ? SUPERVISOR_LEVEL_LABEL[run.level] : null;
  const level = `supervisor ${SUPERVISOR_LEVEL_LABEL[supervisorLevel]}${actual ? ` → ${actual}` : ''}`;
  return [
    paint(level, supervisorLevel === 'act'),
    ...(mergeAtGatesAutomatically ? [style.grey('auto-merge')] : []),
    ...(autorun ? [style.yellow('autorun')] : []),
  ].join(style.grey(' · '));
}

/**
 * A pane pinned away from its live tail with nothing saying so reads as broken,
 * which is the complaint that started all of this. It rides the status row
 * rather than the footer because that row is always exactly one line: a hint
 * that appeared and disappeared in the footer would change the body's height,
 * and a page notch measured from it would differ going up and coming back.
 */
function scrolledBackMark(state: TuiState): string {
  return state.focus !== 'plan' && state.scroll > 0 ? '↑ scrolled back · pgdn for live' : '';
}

/** The status on the left, the settings badge on the right while both fit; the status wins the row when not. */
function renderStatus(state: TuiState, cols: number, panes: BodyPanes): string {
  const left = statusText(state, cols, panes);
  const badge = settingsBadge(state);
  if (!badge) return left;
  const gap = cols - width(left) - width(badge);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${badge}` : left;
}

function statusText(state: TuiState, cols: number, panes: BodyPanes): string {
  const mark = scrolledBackMark(state);
  // A standing stop-arm outranks the activity: with the arm up, the next key
  // decides the turn and that is what the row must say, in red, hard left.
  const armed = stopHint(state);
  if (armed) return truncate(style.red(armed), cols);
  const activity = chatActivity(state);
  // Without a plan pane the run has nowhere else to show what it waits on.
  const hint = !panes.plan || panes.plan.rows === 0 ? runHint(state) : '';
  const notes = [mark, activity && !activity.busy ? activity.label : '', hint, state.toast].filter(Boolean).join(' · ');
  if (activity?.busy || activity?.quiet) {
    // A quiet runner gets the plan pane's static marker, never the spinner.
    const glyph = activity.busy ? SPINNER[state.spinnerFrame % SPINNER.length] : QUIET_MARK;
    const scrolled = mark ? style.grey(`${mark} · `) : '';
    const stop = runnerStoppable(state) ? ' · ctrl-x to stop' : '';
    const elapsed = elapsedSince(activity.since, state.now);
    const time = elapsed ? ` ${elapsed}` : '';
    // The label holds runner output, and it gives way before the time and the stop key do.
    const room = Math.max(1, cols - width(scrolled) - width(glyph) - 1 - width(time) - width(stop));
    const label = truncate(sanitize(activity.label).replace(/\s+/g, ' ').trim(), room);
    return truncate(`${scrolled}${style.brand(glyph)} ${label}${time}${stop}`, cols);
  }
  return notes ? truncate(style.grey(notes), cols) : '';
}

/**
 * Cyan-highlight ranges (absolute offsets into the input) for every `/word`
 * token that could resolve to a *discovered* skill — a live,
 * character-by-character prefix match while composing, not just an exact
 * name, and never a built-in (those keep their plain styling). Trailing
 * punctuation on a token is left uncoloured even when the name before it
 * matches, mirroring how resolveSkillInvocation keeps it out of the name.
 * A skill name repeated verbatim only highlights its first occurrence —
 * the skill loads once, so nothing here should look "recognized" that
 * resolution then leaves as plain text.
 */
function highlightSpans(text: string, runner: readonly RunnerCommand[] | null): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  // A task chat's `/name` is its runner's (#66), and only at the start.
  if (runner) {
    const lead = slashTokens(text)[0];
    return lead?.start === 0 && runnerCommandFor(runner, lead.name) ? [{ start: lead.start, end: lead.nameEnd }] : [];
  }
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
    out += text.slice(cursor, localStart) + style.brand(text.slice(localStart, localEnd));
    cursor = localEnd;
  }
  return out + text.slice(cursor);
}

/**
 * The composer on the same grey band as a sent message: an empty row above and
 * below, every row painted to the edge. It sits under both panes, so the edge
 * is the terminal's — the divider ends above it — and the draft wraps at that
 * same width. With colour off the empty rows stay, so the row count the layout
 * reserves does not depend on the terminal's palette.
 */
function renderInput(state: TuiState): string[] {
  const view = composerView(state);
  const rows = ['', ...composerLines(state, view), ''];
  // The last band row carries the count of what the window leaves out, so a
  // pasted draft never looks complete when it is not.
  if (view && (view.hiddenBefore > 0 || view.hiddenAfter > 0)) rows[rows.length - 1] = style.bandGrey(hiddenDraftNote(view));
  return style.enabled ? rows.map((row) => style.band(pad(row, state.cols))) : rows;
}

function hiddenDraftNote({ hiddenBefore, hiddenAfter }: ComposerView): string {
  const parts = [
    ...(hiddenBefore > 0 ? [`${hiddenBefore} earlier`] : []),
    ...(hiddenAfter > 0 ? [`${hiddenAfter} later`] : []),
  ];
  return `… ${parts.join(' and ')} characters not shown`;
}

function composerLines(state: TuiState, view: ComposerView | null): string[] {
  // A script's log is output only (ADR-0035): say so where the composer would be.
  if (scriptTaskView(state)) {
    return [style.bandGrey(`${chatPromptLabel(state)}  ·  this script task runs no model, so it takes no messages`)];
  }
  const prompt = state.taskView
    ? style.accent(`${chatPromptLabel(state)} `)
    : state.focus === 'plan' ? style.bandGrey('❯ ') : style.brand('❯ ');
  // The driver hides the hardware cursor, so the frame marks the caret itself —
  // but only while keystrokes actually go to the editor.
  const lines = view?.lines ?? null;
  const room = chatEditorRoomFor(state, lines !== null);
  const { text, cursor } = state.editor;
  const continuation = ' '.repeat(width(prompt));

  // A blurred editor never wraps — a literal \n here would push every
  // following row down one line, so newlines/tabs are squashed to one row.
  if (!lines || !view) {
    const visible = text.replace(/\n/g, '¶').replace(/\t/g, ' ');
    const painted = paintSpans(visible, 0, highlightSpans(text, state.taskView ? taskLogCommands(state.taskView.view) : null));
    return [prompt + painted + suggest(state, room - width(visible))];
  }

  const spans = highlightSpans(view.text, state.taskView ? taskLogCommands(state.taskView.view) : null);
  // The caret is derived from the same wrapped lines rather than re-wrapping,
  // which doubled the cost of every keystroke on a long input.
  const { line: lineIndex, col } = cursorInLines(lines, cursor - view.base, view.text.length);

  return lines.map(({ line: raw, start: base }, i) => {
    const prefix = i === 0 ? prompt : continuation;
    const line = raw.replace(/\t/g, ' ');
    const isCursorLine = i === lineIndex;
    if (!isCursorLine) return prefix + paintSpans(line, base, spans);

    const before = paintSpans(line.slice(0, col), base, spans);
    const caretChar = firstGrapheme(line.slice(col)) || ' ';
    const after = paintSpans(line.slice(col + caretChar.length), base + col + caretChar.length, spans);
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
  const matches = composerCompletions(token, state.taskView ? taskLogCommands(state.taskView.view) : null);
  if (matches.length === 0) return '';
  const names = matches.join(' ');
  return style.bandGrey(`  ${truncate(names, Math.max(0, room - 2))}`);
}

/**
 * Packed on plain text, painted after: each hint's key in the default colour,
 * what it does in grey, the way an overlay's `keyHints` reads.
 */
function renderFooter(state: TuiState, cols: number): string[] {
  const paint = (hint: string): string => {
    const gap = hint.indexOf(' ');
    return gap < 0 ? hint : `${hint.slice(0, gap)}${style.grey(hint.slice(gap))}`;
  };
  return packHints(footerHints(state), cols)
    .map((line) => truncate(line.split(' · ').map(paint).join(style.grey(' · ')), cols));
}

// ── Body ─────────────────────────────────────────────────────────────────────

// Erase to end of line, then put the cursor on an absolute column of the row it
// is already on. Both are width-zero to `width()` — `stripAnsi` drops every
// escape sequence, not only colour — so a row carrying them still measures, and
// still slices for selection, exactly as the text alone would.
const ERASE_TO_END = '\x1b[K';
const atColumn = (col: number): string => `\x1b[${col}G`;

/**
 * The panes and, side by side, the divider between them.
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
 *
 * Stacked panes share no row, so there is no divider and nothing to anchor: the
 * plan's pinned header is what tells the two apart.
 */
function renderBody(state: TuiState, { mode, chat: chatRect, plan: planRect }: BodyPanes): string[] {
  const chat = renderChat(state, chatRect.rows, chatRect.cols);
  if (!planRect) return chat;

  const plan = renderPlan(state, planRect.rows, planRect.cols);
  if (mode === 'stacked') return [...fit(chat, chatRect.rows, 'top'), ...plan];

  // The pane border takes the task view's accent, so the runner's pane is
  // unmistakably not the planner's even at a glance.
  const border = state.taskView ? style.accent('│') : style.grey('│');
  const divider = `${ERASE_TO_END}${atColumn(chatRect.cols + 1)}${border}`;

  return Array.from({ length: chatRect.rows }, (_, i) =>
    `${pad(chat[i] ?? '', chatRect.cols)}${divider}${pad(plan[i] ?? '', planRect.cols)}`,
  );
}

function renderChat(state: TuiState, rows: number, cols: number): string[] {
  // Newest content wins the available space; the top scrolls away — unless the
  // user paged back, in which case the view holds `scroll` lines off the tail.
  // The offset is already clamped where it is written, so the `min` here is a
  // belt against a resize that shrank the content under a live offset.
  const { lines, header, footer, anchor, maxScroll } = chatLayout(state, rows, cols);
  const back = Math.min(state.scroll, maxScroll);
  const body = Math.max(0, rows - header.length - footer.length);
  return [...header, ...fit(lines.slice(0, lines.length - back), body, anchor), ...footer];
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
  if (overlay.kind === 'help') return renderHelp(overlay.scroll ?? 0, overlay.sheet ?? 'commands', rows, cols);
  if (overlay.kind === 'approval') {
    return frame('Approval needed', approvalLayout(state, overlay.request, overlay.scroll ?? 0, rows, cols).lines, rows, cols);
  }
  if (overlay.kind === 'confirm') return renderConfirm(overlay, rows, cols);
  if (overlay.kind === 'prompt') {
    // API keys are secrets — never echo one to a screen that may be shared.
    const secret = overlay.action.kind === 'api-key';
    const shown = secret ? '•'.repeat(overlay.value.length) : overlay.value;
    return frame(
      overlay.title,
      [overlay.hint ? style.grey(overlay.hint) : '', '', `${style.brand('❯')} ${shown}`, '', style.grey('enter confirms · esc cancels')],
      rows,
      cols,
    );
  }
  if (overlay.kind === 'handoff') return renderHandoff(state, overlay, rows, cols);
  if (overlay.kind === 'stepper') return renderStepper(overlay.stepper, rows, cols);
  return renderPicker(overlay.picker, rows, cols);
}

function renderHandoff(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'handoff' }>,
  rows: number,
  cols: number,
): string[] {
  const handoff = currentHandoff(state);
  if (!handoff) return frame('Handoff', [style.grey('Nothing to hand off.')], rows, cols);

  if (overlay.diff) {
    const room = diffRoom(rows);
    const { lines, scroll } = overlay.diff;
    // Cut, not wrapped: the scroll counts one row per diff line, and a wrapped
    // line would push the end of the diff and the footer out of the frame.
    const shown = lines.slice(scroll, scroll + room).map((line) => paintDiffLine(truncate(line, Math.max(1, cols - 2))));
    const more = scroll + room < lines.length ? '↑↓ pgup/pgdn scroll · ' : '';
    return frame(`Diff: ${handoffBranchName(handoff)}`, [...shown, '', style.grey(`${more}enter or esc goes back`)], rows, cols);
  }

  const landed = handoff.landed.length === 0
    ? [style.grey('Nothing landed on it.')]
    : handoff.landed.map((task) => {
      const repaired = task.repairedFiles?.length
        ? style.yellow(`: repaired (${capConflictFiles(task.repairedFiles)})`)
        : '';
      return `  ${style.green('✓')} ${titledTaskRefOf(state.tasks, task.taskId) ?? titledTaskRef(task)}${repaired}`;
    });
  const actions = handoffActions(handoff).map((action, index) => {
    const active = index === overlay.index;
    const caret = active ? style.brand('❯') : ' ';
    return `${caret} ${active ? style.bold(action.label) : action.label}${style.grey(`: ${action.hint}`)}`;
  });
  // A group answers per repo first: Merge all is one step over all of them, so
  // the user needs to see which have work before taking it.
  const perRepo = isRepoGroup(handoff)
    ? ['Per repository:', ...handoff.repos.map((repo, i) => `  ${repo.landed.length > 0 ? style.green('✓') : style.grey('·')} ${repoResultLines(handoff)[i]}`), '']
    : [];
  return frame(
    'Run handoff',
    [
      `Branch  ${style.brand(handoffBranchName(handoff))}`,
      style.grey(`Forked from ${handoffBaseLine(handoff, 12)}`),
      '',
      ...perRepo,
      'Landed on it, in plan order:',
      ...landed,
      '',
      ...actions,
      '',
      style.grey('↑↓ choose · enter selects · esc closes'),
    ],
    rows,
    cols,
  );
}

function paintDiffLine(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return style.bold(line);
  if (line.startsWith('+')) return style.green(line);
  if (line.startsWith('-')) return style.red(line);
  if (line.startsWith('@@')) return style.cyan(line);
  return line;
}

function renderPicker(picker: PickerState, rows: number, cols: number): string[] {
  const items = visibleItems(picker);
  const inner = Math.max(1, cols - 2);
  const head = [
    ...(picker.hint ? wrap(picker.hint, inner).map((line) => style.grey(line)) : []),
    ...(picker.filterable ? [`${style.grey('filter:')} ${picker.filter}${style.grey('▏')}`] : []),
    '',
  ];
  const footer = keyHints([
    ...(picker.multi ? [['space', 'toggles'] as const] : []),
    ['enter', picker.multi ? 'confirms' : 'selects'],
    ['esc', 'cancels'],
    ...(picker.filterable ? [['type', 'to filter'] as const] : []),
  ]);
  const room = Math.max(1, rows - head.length - 3);
  const list = items.length === 0
    ? [style.grey(picker.filter ? 'Nothing matches that filter.' : 'Nothing to show yet…')]
    : pickerRows({ items, index: picker.index, numbered: !picker.filterable, chosen: picker.multi ? picker.chosen : undefined }, room, inner);
  return frame(picker.title, [...head, ...list, '', footer], rows, cols);
}

function renderStepper(stepper: StepperState, rows: number, cols: number): string[] {
  const { definition, trail } = stepper;
  const active = definition.steps[stepper.current];
  const items = matchingItems(stepper.items, stepper.filter);
  const inner = Math.max(1, cols - 2);
  const at = trail.findIndex((t) => t.active);
  const header = trail
    .map((t) => (t.active
      ? style.highlight(style.bold(t.label))
      : t.value !== undefined ? `${style.grey(`${t.label}:`)} ${t.value}` : style.grey(t.label)))
    .join(style.grey(' › '));
  const hint = active.hint ?? definition.hint;
  const top = [truncate(header, inner), ...(hint ? wrap(hint, inner).map((line) => style.grey(line)) : [])];
  const enter = ['enter', definition.afterSave === 'stay' ? 'sets' : at === trail.length - 1 ? 'done' : 'next'] as const;
  const cancel = ['esc', 'closes'] as const;
  const switchStep = trail.length > 1 ? [['←/→', 'switch step'] as const] : [];
  if (active.number) {
    const input = `${style.brand('❯')} ${stepper.entry?.text ?? ''}${style.grey('▏')}`;
    const footer = keyHints([enter, ['↑/↓', 'change'], ...switchStep, cancel]);
    return frame(definition.title, [...top, '', input, style.grey(`At least ${active.number.min}.`), '', footer], rows, cols);
  }
  const head = [
    ...top,
    ...(active.filterable ? [`${style.grey('filter:')} ${stepper.filter}${style.grey('▏')}`] : []),
    '',
  ];
  const footer = keyHints([
    enter,
    ...switchStep,
    ...(active.filterable ? [['type', 'to filter'] as const] : []),
    cancel,
  ]);
  const room = Math.max(1, rows - head.length - 3);
  const list = items.length === 0
    ? [style.grey(stepper.filter ? 'Nothing matches that filter.' : 'Nothing to show yet…')]
    : pickerRows({ items, index: stepper.index, numbered: !active.filterable }, room, inner);
  return frame(definition.title, [...head, ...list, '', footer], rows, cols);
}

/** Columns between a list's label column and its detail column. */
const DETAIL_GAP = 2;

interface PickerRowList {
  items: PickerItem[];
  index: number;
  numbered: boolean;
  /** The ticked ids of a multi-select; absent, the list marks its current item instead. */
  chosen?: string[];
}

/**
 * A list's rows, at most `room` lines of `inner` columns: the label column is
 * as wide as the widest label, the detail wraps inside its own column, and a
 * list longer than `room` says how much is above and below rather than
 * clipping silently.
 */
function pickerRows(list: PickerRowList, room: number, inner: number): string[] {
  const { items, numbered, chosen } = list;
  const index = Math.max(0, Math.min(list.index, items.length - 1));
  const digits = String(items.length).length;
  const prefixWidth = 2 + (numbered ? digits + 2 : 0) + (chosen ? 4 : 0);
  const rowWidth = Math.max(1, inner - prefixWidth);
  const isCurrent = (item: PickerItem): boolean => !chosen && item.selected === true;
  const widest = Math.max(0, ...items.map((item) => width(item.label) + (isCurrent(item) ? 2 : 0)));
  // The label column gives way first: a detail squeezed into a few columns
  // stops reading as a sentence, while a long label still reads cut short.
  const labelWidth = items.some((item) => item.detail)
    ? Math.min(widest, Math.max(8, rowWidth - DETAIL_GAP - Math.max(16, Math.floor(rowWidth / 3))))
    : Math.min(widest, rowWidth);
  const detailWidth = Math.max(1, rowWidth - labelWidth - DETAIL_GAP);
  const detailIndent = ' '.repeat(prefixWidth + labelWidth + DETAIL_GAP);

  const block = (item: PickerItem, i: number): string[] => {
    const active = i === index;
    const current = isCurrent(item);
    const number = numbered ? `${String(i + 1).padStart(digits)}. ` : '';
    const mark = chosen ? `${chosen.includes(item.id) ? style.green('[✓]') : style.grey('[ ]')} ` : '';
    const name = truncate(item.label, Math.max(1, labelWidth - (current ? 2 : 0)));
    // A warn row is still selectable, so its label takes the red while its
    // detail keeps the list's usual paint: the detail is guidance, not the alarm.
    const painted = item.disabled
      ? style.grey(name)
      : item.warn
        ? style.red(active ? style.bold(name) : name)
        : active ? style.bold(name) : name;
    const tick = current ? ` ${style.green('✔')}` : '';
    const label = `${painted}${tick}${' '.repeat(Math.max(0, labelWidth - width(name) - (current ? 2 : 0)))}`;
    // The bar is one colour: grey detail on it would read as a hole in it.
    const paint = (line: string): string => (active ? line : style.grey(line));
    const detail = item.detail ? wrap(item.detail, detailWidth) : [];
    const lines = [
      `${active ? '❯' : ' '} ${number}${mark}${detail.length > 0 ? `${label}${' '.repeat(DETAIL_GAP)}${paint(detail[0])}` : label}`,
      ...detail.slice(1).map((line) => `${detailIndent}${paint(line)}`),
    ];
    return active ? lines.map((line) => style.highlight(pad(line, inner))) : lines;
  };

  const blocks = items.map(block);
  if (blocks.reduce((n, b) => n + b.length, 0) <= room) return blocks.flat();

  // Grow outward from the active row, one side then the other, so it stays
  // near the middle until one end of the list is reached.
  const fit = Math.max(1, room - 2);
  let lo = index;
  let hi = index;
  let used = blocks[index].length;
  for (let grew = true; grew;) {
    grew = false;
    if (hi + 1 < blocks.length && used + blocks[hi + 1].length <= fit) {
      hi += 1;
      used += blocks[hi].length;
      grew = true;
    }
    if (lo > 0 && used + blocks[lo - 1].length <= fit) {
      lo -= 1;
      used += blocks[lo].length;
      grew = true;
    }
  }
  return [
    ...(lo > 0 ? [style.grey(`  ↑ … +${lo} more`)] : []),
    ...blocks.slice(lo, hi + 1).flat().slice(0, fit),
    ...(hi < blocks.length - 1 ? [style.grey(`  ↓ … +${blocks.length - 1 - hi} more`)] : []),
  ];
}

/** A footer of keys: the key in bold, what it does in grey. */
function keyHints(hints: readonly (readonly [string, string])[]): string {
  return hints.map(([key, meaning]) => `${style.bold(key)} ${style.grey(meaning)}`).join(style.grey(' · '));
}

function renderHelp(scroll: number, sheet: HelpSheet, rows: number, cols: number): string[] {
  const { lines, room, maxScroll } = helpLayout(rows, cols, sheet);
  const offset = Math.min(scroll, maxScroll);
  const footer = style.grey(offset < maxScroll ? '↑↓ scroll · any other key closes' : 'any key closes');

  return frame(sheet === 'keys' ? 'Keys' : 'Commands', [...lines.slice(offset, offset + room), footer], rows, cols);
}

/** Most rows of a quoted message a confirmation shows before it cuts to an ellipsis. */
const QUOTE_MAX_LINES = 8;

function renderConfirm(overlay: Extract<Overlay, { kind: 'confirm' }>, rows: number, cols: number): string[] {
  const { choice, quote, note } = overlay;
  const inner = Math.max(1, cols - 3);
  const options = (choice?.options ?? []).map((o, i) => `${i === choice?.index ? style.brand('❯') : ' '} ${i + 1}. ${o.label}`);
  const hint = choice
    ? style.grey(`↑↓ move · enter or 1–${choice.options.length} chooses · esc cancels`)
    : style.grey('enter confirms · esc cancels');
  const noteLines = note ? ['', ...note.split('\n')] : [];
  const rest = [...noteLines, ...(options.length > 0 ? ['', ...options] : []), '', hint];

  const quoted: string[] = [];
  if (quote !== undefined) {
    // The options are what the user is answering, so a long quote gives up
    // rows to them rather than pushing them off the bottom of a short pane.
    const fixed = 1 + wrap(overlay.message, inner).length + 1 + 1 + rest.flatMap((l) => wrap(l, inner)).length;
    const room = Math.max(2, Math.min(QUOTE_MAX_LINES, rows - fixed));
    const wrapped = wrap(quote, inner - 2);
    const shown = wrapped.length > room ? [...wrapped.slice(0, room - 1), '…'] : wrapped;
    quoted.push('', ...shown.map((l) => `${style.grey('│')} ${l}`));
  }
  return frame(overlay.title, [overlay.message, ...quoted, ...rest], rows, cols);
}

/** A titled box the width of the pane, padded or clipped to exactly `rows`. */
function frame(title: string, body: string[], rows: number, cols: number): string[] {
  const inner = Math.max(1, cols - 2);
  const lines = [
    `${style.grey('╭─ ')}${style.bold(style.brand(title))}${style.grey(` ${'─'.repeat(Math.max(0, inner - width(title) - 3))}`)}`,
    ...body.flatMap((line) => wrap(line, inner)).map((line) => ` ${truncate(line, inner)}`),
  ];
  return fit(lines, rows, 'top');
}
