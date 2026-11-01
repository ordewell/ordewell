import {
  accountLimitsText, contextMeterText, type AccountLimitSnapshot, approvalKindText, approvalStatusText, compactionText, diffRows, diffSummary, handoffFindingsText, handoffReferenceText, loadedSkillTokens, outputPreview, planMarkerParts, savedPatchViews, severityLabel, usageText, wakeUpItems, worstSeverity, REPORT_PREVIEW_LINES,
  type DiffRow, type DiffStat,
  type ApprovalBlock, type DisplayBlock, type MessageBlock, type MessageRole, type PlanBlock,
  type CommandBlock, type CommandStatus, type CompactionBlock, type RunnerLoadedBlock,
  type FindingSeverity, type HandoffBlock, type HandoffFinding,
  type SkillLoadBlock, type SubagentBlock, type SubagentStatus, type ThinkingDisplayBlock, type ToolBlock,
} from '@ordewell/core';
import { graphemes, pad, sanitize, style, truncate, width, wrap, wrapLines } from './ansi';
import { renderMarkdown } from './markdown';

/*
 * How the chat pane draws core's display blocks (#51). Pure: a block, the pane
 * width and the detail-all switch in, painted lines out. Every text here came
 * from a model, a tool or a runner, so it is sanitized where it is drawn.
 */

type Paint = (text: string) => string;

function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function firstLine(text: string): string {
  return sanitize(text).trim().split('\n')[0].trim();
}

/**
 * The head of a block's text. A model can stream megabytes just as a test run
 * prints them, and re-wrapping all of it on every delta is the same freeze;
 * past this many characters the frame shows the head and says how much it
 * left out, so nothing disappears without a word.
 */
const TEXT_DISPLAY_CHARS = 32 * 1024;

function shownText(text: string): { text: string; hiddenChars: number } {
  if (text.length <= TEXT_DISPLAY_CHARS) return { text, hiddenChars: 0 };
  // Prefer a line boundary near the cap so the cut does not split a sentence
  // in the middle; a single unbroken line is cut where the budget ends.
  const boundary = text.lastIndexOf('\n', TEXT_DISPLAY_CHARS);
  const cut = boundary > TEXT_DISPLAY_CHARS - 2_000 ? boundary : TEXT_DISPLAY_CHARS;
  return { text: text.slice(0, cut), hiddenChars: text.length - cut };
}

function textCutNote(hiddenChars: number): string {
  return style.grey(`… ${countOf(hiddenChars, 'character')} not shown`);
}

/** The end of `text` that fits in `max` columns. */
function tailOf(text: string, max: number): string {
  const clusters = graphemes(text);
  let out = '';
  let used = 0;
  for (let i = clusters.length - 1; i >= 0 && used + width(clusters[i]) <= max; i--) {
    out = clusters[i] + out;
    used += width(clusters[i]);
  }
  return out;
}

// ── Messages and thinking ────────────────────────────────────────────────────

const ROLE_PREFIX: Record<MessageRole, Paint> = {
  user: (t) => `${style.bandGrey('❯')} ${t}`,
  planner: (t) => `${style.brand('◆')} ${t}`,
  agent: (t) => `${style.brand('◆')} ${t}`,
  supervisor: (t) => `${style.yellow('◇')} ${t}`,
  wake_up: (t) => style.yellow(`↯ ${t}`),
  system: (t) => style.grey(`· ${t}`),
  error: (t) => `${style.red('✗')} ${style.red(t)}`,
};

// A wrapped line's rows after the first keep the role's colour when the first
// row is painted as a whole (system grey, error red, wake_up yellow); the
// markdown roles carry their own colour inside the text and the user's rows
// sit on a band, so those stay as they were.
const ROLE_CONTINUATION: Partial<Record<MessageRole, Paint>> = {
  system: style.grey,
  error: style.red,
  wake_up: style.yellow,
};

function messageLines(block: MessageBlock, cols: number): string[] {
  const shown = shownText(block.text);
  const text = sanitize(shown.text);
  const room = Math.max(1, cols - 2);
  const wrapped = block.role === 'planner' || block.role === 'agent' || block.role === 'supervisor'
    ? renderMarkdown(text, room)
    : block.skills ? skillPaintedLines(text, block.skills, room) : wrap(text, room);
  const rest: Paint = ROLE_CONTINUATION[block.role] ?? ((t) => t);
  const rows = wrapped.map((line, i) => (i === 0 ? ROLE_PREFIX[block.role](line) : rest(`  ${line}`)));
  if (shown.hiddenChars > 0) rows.push(textCutNote(shown.hiddenChars));
  if (block.role === 'user' && block.forced) {
    const note = style.grey(' · sent now');
    if (width(rows[0]) + width(note) <= cols) rows[0] += note;
    else rows.push(` ${note}`);
  }
  return block.role === 'user' ? onBand(rows, cols) : rows;
}

/**
 * A run update that carries a report (ADR-0037 R2): the update's own lines as
 * they were, and each report beneath its task, in the default colour so it
 * reads as text rather than as Ordewell's voice. Folded after a few lines, and
 * the fold counts what it leaves out; null for an update with no report, which
 * is drawn as any message.
 */
function reportUpdateLines(block: MessageBlock, cols: number, detailAll: boolean): string[] | null {
  const shown = shownText(block.text);
  const items = wakeUpItems(sanitize(shown.text));
  if (!items.some((item) => item.kind === 'report')) return null;
  const rows = [style.yellow(`↯ Run update:`)];
  for (const item of items) {
    if (item.kind === 'line') {
      rows.push(...wrap(item.text, Math.max(1, cols - 2)).map((line) => style.yellow(`  ${line}`)));
      continue;
    }
    rows.push(...wrap(`- task ${item.task} ended, with this report:`, Math.max(1, cols - 2)).map((line) => style.yellow(`  ${line}`)));
    const room = Math.max(1, cols - 4);
    const shownLines = detailAll ? item.lines : item.lines.slice(0, REPORT_PREVIEW_LINES);
    rows.push(...shownLines.flatMap((line) => wrap(line, room)).map((line) => `    ${line}`));
    const hidden = item.lines.length - shownLines.length;
    if (hidden > 0) rows.push(style.grey(`    … +${countOf(hidden, 'line')} of the report (ctrl+o to expand)`));
    else if (detailAll && item.lines.length > REPORT_PREVIEW_LINES) rows.push(style.grey('    … (ctrl+o to collapse)'));
  }
  if (shown.hiddenChars > 0) rows.push(textCutNote(shown.hiddenChars));
  return rows;
}

/** An empty row above and below, every row painted out to the pane's edge; with colour off only the empty rows remain. */
function onBand(rows: string[], cols: number): string[] {
  const band = ['', ...rows, ''];
  return style.enabled ? band.map((row) => style.band(pad(row, cols))) : band;
}

/** Wrapped, with each `/name` that loaded a skill painted as the composer paints one being typed. */
function skillPaintedLines(text: string, skills: readonly string[], room: number): string[] {
  const tokens = loadedSkillTokens(text, skills);
  return wrapLines(text, room).map(({ line, start }) => {
    let painted = '';
    let at = 0;
    for (const token of tokens) {
      const from = Math.max(token.start - start, at);
      const to = Math.min(token.end - start, line.length);
      if (to <= from) continue;
      painted += line.slice(at, from) + style.brand(line.slice(from, to));
      at = to;
    }
    return painted + line.slice(at);
  });
}

/** The path gives way first: it is the part a reader can do without. */
function skillLoadLine(block: SkillLoadBlock, cols: number): string {
  const head = block.attaches
    ? `● /${sanitize(block.name)} will be attached to fitting tasks · `
    : block.invokedBy === 'planner'
      ? `● ${sanitize(block.name)} skill loaded by planner · `
      : `● /${sanitize(block.name)} skill loaded · `;
  const line = truncate(`${head}${truncatePath(sanitize(block.path), Math.max(1, cols - width(head)))}`, cols);
  return `${style.green('●')}${style.grey(line.slice(1))}`;
}

function thinkingLines(block: ThinkingDisplayBlock, cols: number, detailAll: boolean): string[] {
  const shown = shownText(block.text);
  const text = sanitize(shown.text).trim();
  const head = `∴ Thinking (${countOf(text ? text.split(/\s+/).length : 0, 'word')})`;
  if (detailAll) {
    const body = text ? wrap(text, Math.max(1, cols - 2)).map((line) => style.grey(`  ${line}`)) : [];
    return [style.grey(truncate(head, cols)), ...body, ...(shown.hiddenChars > 0 ? [textCutNote(shown.hiddenChars)] : [])];
  }
  const latest = block.streaming ? (text.split('\n').at(-1) ?? '').trim() : '';
  const room = cols - width(`${head} · `);
  if (!latest || room < 2) return [style.grey(truncate(head, cols))];
  // A live line grows at its end, so a row too short for it keeps the end;
  // the ellipsis says the slice starts mid-sentence.
  const shownLatest = width(latest) > room ? `…${tailOf(latest, room - 1)}` : latest;
  return [style.grey(`${head} · ${shownLatest}`)];
}

// ── Command rows ─────────────────────────────────────────────────────────────

/** Rows under a command's header hang off `⎿`, and every row after the first keeps its indent. */
const OUTPUT_HEAD = '  ⎿  ';
const OUTPUT_INDENT = '     ';
const PREVIEW_LINES = 3;

/**
 * A tool's output is only ever read at its head. Test runs and builds print
 * megabytes, and sanitizing, splitting and wrapping all of it on every frame
 * is what froze the pane while a task's suite ran: each new chunk made the
 * block a new object, so the drawn-line cache missed and the whole output was
 * parsed again. Past these bounds the head is shown and the rest is counted,
 * with a row that says so — the block still holds all of it, only the frame is
 * bounded.
 */
const FULL_OUTPUT_MAX = 64 * 1024;
const PREVIEW_CHARS = 4 * 1024;
const DETAIL_LINES = 2_000;
const DETAIL_CHARS = 256 * 1024;
const DIFF_LINES = 2_000;
const DIFF_CHARS = 256 * 1024;

interface OutputHead {
  lines: string[];
  hiddenLineCount: number;
}

/**
 * Line count of an output that only grows, remembered across frames. Concatenating
 * a chunk onto `block.output` makes a new string, so a per-block cache never
 * hits; remembering the last text and adding the new tail's newlines does.
 */
let countedOutput: { text: string; count: number } | null = null;

function countNewlines(text: string, from = 0): number {
  let count = 0;
  for (let at = text.indexOf('\n', from); at >= 0; at = text.indexOf('\n', at + 1)) count += 1;
  return count;
}

function lineCountOf(output: string): number {
  const memo = countedOutput;
  if (memo && output.startsWith(memo.text)) {
    const count = memo.count + countNewlines(output, memo.text.length);
    countedOutput = { text: output, count };
    return count;
  }
  const count = countNewlines(output);
  countedOutput = { text: output, count };
  return count;
}

/**
 * The first `maxLines` lines, sanitized later by the caller, reading no more
 * than `maxChars` of them. `full` marks a head that more output cannot change:
 * either enough lines were taken, or the character budget was reached.
 */
let headOutput: { text: string; maxLines: number; maxChars: number; lines: string[]; full: boolean } | null = null;

function headLines(output: string, maxLines: number, maxChars: number): string[] {
  const memo = headOutput;
  if (memo && memo.maxLines === maxLines && memo.maxChars === maxChars && memo.full && output.startsWith(memo.text)) {
    return memo.lines;
  }
  const lines: string[] = [];
  let start = 0;
  let used = 0;
  let full = false;
  while (lines.length < maxLines) {
    if (start > output.length) {
      full = true;
      break;
    }
    const end = output.indexOf('\n', start);
    const stop = end < 0 ? output.length : end;
    const length = stop - start;
    // The first line always lands, even when a single minified line is wider
    // than the character budget; it is cut rather than dropped.
    if (lines.length > 0 && used + length > maxChars) {
      full = true;
      break;
    }
    lines.push(length > maxChars ? output.slice(start, start + maxChars) : output.slice(start, stop));
    used += Math.min(length, maxChars) + 1;
    if (end < 0) {
      full = true;
      break;
    }
    start = end + 1;
  }
  if (lines.length >= maxLines || used >= maxChars) full = true;
  headOutput = { text: output, maxLines, maxChars, lines, full };
  return lines;
}

/**
 * What a block shows of its output: the head, and how many lines it leaves
 * out. Small outputs keep `outputPreview`'s exact trimming; large ones are
 * bounded so the cost of a frame does not grow with the run's output.
 */
function shownOutput(output: string, maxLines: number, maxChars: number): OutputHead {
  if (output.length <= FULL_OUTPUT_MAX) return outputPreview(output, maxLines);
  const lines = headLines(output, maxLines, maxChars);
  const total = output.length === 0 ? 0 : lineCountOf(output) + 1;
  return { lines, hiddenLineCount: Math.max(0, total - lines.length) };
}

/** `output` cut to the rows a diff may read, for the same reason. */
function diffOutput(output: string): { text: string; hiddenLineCount: number } {
  if (output.length <= FULL_OUTPUT_MAX) return { text: output, hiddenLineCount: 0 };
  const shown = shownOutput(output, DIFF_LINES, DIFF_CHARS);
  return { text: shown.lines.join('\n'), hiddenLineCount: shown.hiddenLineCount };
}

function underHeader(lines: string[]): string[] {
  return lines.map((line, i) => `${i === 0 ? style.grey(OUTPUT_HEAD) : OUTPUT_INDENT}${line}`);
}

/**
 * How a command that did not succeed says so, in the colours the old research
 * log marked outcomes with: a failure is red, a refusal or a denial yellow, a
 * call cut short grey.
 */
function unsettledOutcome(block: ToolBlock): { label: string; paint: Paint } | null {
  switch (block.status) {
    case 'error':
      return { label: 'Error', paint: style.red };
    case 'denied':
      return { label: block.outcome === 'refused' ? 'Refused' : 'Denied', paint: style.yellow };
    case 'interrupted':
      return { label: 'Interrupted', paint: style.grey };
    default:
      return null;
  }
}

/**
 * The header's mark. A call still out is hollow — a static glyph, since the
 * drawn rows are cached per block and a spinner would redraw every one of
 * them per tick.
 */
function commandMark(block: ToolBlock): string {
  if (block.status === 'pending') return style.grey('○');
  return (unsettledOutcome(block)?.paint ?? style.green)('●');
}

// One word with a slash and no scheme: a file path, whose last part is the
// part worth keeping. A URL keeps its host instead.
const PATH_LIKE = /^(?![a-z][a-z0-9+.-]*:\/\/)\S*\/\S*$/i;

/** Cut a path from the left to `max` columns, starting at a directory boundary when one fits. */
function truncatePath(path: string, max: number): string {
  if (width(path) <= max) return path;
  let tail = '';
  for (const char of graphemes(path).reverse()) {
    if (width(char + tail) > max - 1) break;
    tail = char + tail;
  }
  const slash = tail.search(/[\\/]/);
  return `…${slash > 0 ? tail.slice(slash) : tail}`;
}

/**
 * `● Name(keyArg)` on one row. The argument gives way first, so the row still
 * names the tool and still closes its parenthesis. In full detail the header
 * wraps instead: nothing there is cut.
 */
function commandHeader(block: ToolBlock, cols: number, detailAll: boolean): string[] {
  const name = sanitize(block.headline.name);
  const keyArg = sanitize(block.headline.keyArg);
  // A sealed run had no network, no home and kept nothing it wrote (ADR-0036 S4).
  const tag = block.sealed ? ' · sealed' : '';
  if (detailAll) {
    return wrap(`${name}(${keyArg})${tag}`, Math.max(1, cols - 2)).map((line, i) => (i === 0 ? `${commandMark(block)} ${line}` : `  ${line}`));
  }
  const open = `● ${name}(`;
  const room = cols - width(open) - 1 - width(tag);
  const cut = PATH_LIKE.test(keyArg) ? truncatePath(keyArg, room) : truncate(keyArg, room);
  const text = room > 1 ? `${open}${cut})${tag}` : truncate(`${open}${keyArg})${tag}`, cols);
  return [`${commandMark(block)}${text.slice(1)}`];
}

/** A command's arguments as a reader wants them: `key: value` rows, a multi-line value kept as its own lines. */
function argumentLines(args: string): string[] {
  if (!args.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return sanitize(args).split('\n');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sanitize(args).split('\n');
  return Object.entries(parsed).flatMap(([key, value]) => {
    const [first, ...rest] = sanitize(typeof value === 'string' ? value : JSON.stringify(value)).split('\n');
    return [`${key}: ${first}`, ...rest];
  });
}

/**
 * What hangs off `⎿`. Collapsed: a three-line preview that counts what it
 * hides, or one status line. In full detail: everything up to the display
 * cap, then a row that says how much was cut, so a huge output never reads as
 * complete when it is not.
 */
function resultLines(block: ToolBlock, room: number, detailAll: boolean): string[] {
  if (block.status === 'pending') return [style.grey('Running…')];
  const fit = (line: string): string[] => (detailAll ? wrap(line, room) : [truncate(line, room)]);
  const outcome = unsettledOutcome(block);
  if (outcome) {
    const { lines, hiddenLineCount } = shownOutput(block.output, detailAll ? DETAIL_LINES : 1, detailAll ? DETAIL_CHARS : PREVIEW_CHARS);
    const [reason, ...rest] = lines.map(sanitize);
    const status = fit(reason ? `${outcome.label}: ${reason}` : outcome.label).map(outcome.paint);
    const more = hiddenLineCount > 0 ? [style.grey(`… +${countOf(hiddenLineCount, 'line')} not shown`)] : [];
    return detailAll ? [...status, ...rest.flatMap(fit).map(style.grey), ...more] : status;
  }
  if (detailAll) {
    const { lines, hiddenLineCount } = shownOutput(block.output, DETAIL_LINES, DETAIL_CHARS);
    const text = lines.map(sanitize);
    // The collapsed preview counts what it hides; the expanded view marks the
    // same rows with how to fold it back — the note flips rather than vanishes.
    const note = [
      ...(text.length > PREVIEW_LINES ? ['… (ctrl+o to collapse)'] : []),
      ...(hiddenLineCount > 0 ? [`… +${countOf(hiddenLineCount, 'line')} not shown`] : []),
    ];
    return text.length > 0 ? [...text.flatMap(fit), ...note].map(style.grey) : [style.grey('(no output)')];
  }
  const { lines, hiddenLineCount } = shownOutput(block.output, PREVIEW_LINES, PREVIEW_CHARS);
  if (lines.length === 0) return [style.grey('(no output)')];
  const more = hiddenLineCount > 0 ? [`… +${countOf(hiddenLineCount, 'line')} (ctrl+o to expand)`] : [];
  return [...lines.map(sanitize), ...more].map((line) => style.grey(truncate(line, room)));
}

// A diff is read rather than skimmed, so its preview runs longer than a command's.
const DIFF_PREVIEW_ROWS = 10;

const DIFF_PAINT: Record<DiffRow['kind'], (text: string) => string> = {
  added: style.green,
  removed: style.red,
  context: style.grey,
  gap: style.grey,
};
const DIFF_SIGN: Record<DiffRow['kind'], string> = { added: '+', removed: '-', context: ' ', gap: '' };

/**
 * An edit as an editor shows one: what it changed, then its lines numbered,
 * marked `+` green and `-` red. Collapsed, the head of the diff and a count of
 * the rest; in full detail, all of it.
 */
function diffLines(block: ToolBlock, diff: DiffStat, room: number, detailAll: boolean): string[] {
  const bounded = diffOutput(block.output);
  const rows = diffRows(bounded.text);
  const gutter = Math.max(0, ...rows.map((row) => String(row.line ?? '').length));
  const draw = (row: DiffRow): string[] => {
    const text = row.kind === 'gap' ? `${' '.repeat(gutter)} ⋮` : `${String(row.line ?? '').padStart(gutter)} ${DIFF_SIGN[row.kind]} ${sanitize(row.text)}`;
    return (detailAll ? wrap(text, room) : [truncate(text, room)]).map(DIFF_PAINT[row.kind]);
  };
  const shown = detailAll ? rows : rows.slice(0, DIFF_PREVIEW_ROWS);
  const hidden = rows.length - shown.length;
  const more = [
    ...(hidden > 0 ? [style.grey(`… +${countOf(hidden, 'line')} (ctrl+o to expand)`)] : []),
    ...(bounded.hiddenLineCount > 0 ? [style.grey(`… +${countOf(bounded.hiddenLineCount, 'line')} not shown`)] : []),
  ];
  return [diffSummary(diff), ...shown.flatMap(draw), ...more];
}

function toolLines(block: ToolBlock, cols: number, detailAll: boolean): string[] {
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  // An edit's arguments only restate its diff (the old and new text, the whole file written).
  const diff = block.diff && block.status === 'ok' ? block.diff : null;
  const args = detailAll && !diff ? argumentLines(block.args).flatMap((line) => wrap(line, room)).map((line) => OUTPUT_INDENT + style.grey(line)) : [];
  const result = diff ? diffLines(block, diff, room, detailAll) : resultLines(block, room, detailAll);
  return [...commandHeader(block, cols, detailAll), ...args, ...underHeader(result)];
}

// ── Subagents ────────────────────────────────────────────────────────────────

const SUBAGENT_PAINT: Record<SubagentStatus, Paint> = {
  running: style.yellow,
  done: style.green,
  failed: style.red,
  stopped: style.grey,
};

const CHILD_INDENT = '    ';

/**
 * `◆ Agent: brief  status · digest` on one row. The brief gives way before the
 * status, and the digest takes only what is left: how it ended is the part a
 * glance at the row is for.
 */
function subagentHeader(block: SubagentBlock, cols: number): string {
  const brief = firstLine(block.brief);
  const steps = block.children.filter((c) => c.type === 'tool').length;
  const status = block.status === 'running' && steps > 0 ? `running · ${countOf(steps, 'step')}` : block.status;
  const head = brief ? ' Agent: ' : ' Agent';
  const briefRoom = cols - width(`◆${head}  ${status}`);
  if (briefRoom < 4) return truncate(`◆${head}${brief}  ${status}`, cols);
  const named = `${style.brand('◆')}${head}${truncate(brief, briefRoom)}  ${SUBAGENT_PAINT[block.status](status)}`;
  const digest = firstLine(block.digest);
  const digestRoom = cols - width(named) - width(' · ');
  return digest && digestRoom >= 4 ? `${named}${style.grey(` · ${truncate(digest, digestRoom)}`)}` : named;
}

/** In full detail its calls sit indented beneath it, and what it handed back hangs off `⎿` as a command's output does. */
function subagentLines(block: SubagentBlock, cols: number, detailAll: boolean): string[] {
  const header = subagentHeader(block, cols);
  if (!detailAll) return [header];
  const childCols = Math.max(1, cols - CHILD_INDENT.length);
  const children = block.children.flatMap((child) => blockLines(child, childCols, true).map((line) => CHILD_INDENT + line));
  const digest = sanitize(block.digest).trim();
  const handedBack = digest ? underHeader(wrap(digest, Math.max(1, cols - OUTPUT_INDENT.length)).map(style.grey)) : [];
  return [header, ...children, ...handedBack];
}

// ── One-line markers ─────────────────────────────────────────────────────────

/** Status first, so a long subject is what the pane cuts. */
function approvalLine(block: ApprovalBlock, cols: number): string {
  const [mark, paint] = block.status === 'pending'
    ? ['?', style.yellow]
    : block.status === 'granted'
      ? ['✓', style.green]
      : block.status === 'withdrawn'
        ? ['·', style.grey]
        : ['⊘', style.yellow];
  const note = block.note ? `: “${firstLine(block.note)}”` : '';
  const line = `${mark} ${approvalStatusText(block)} · ${approvalKindText(block.kind)}: ${firstLine(block.subject)}${note}`;
  return `${paint(mark)}${truncate(line, cols).slice(mark.length)}`;
}

/** A settled request's body is a record, so a long one is counted rather than filling the transcript. */
const SETTLED_BODY_LINES = 20;

/**
 * What a script task's start was asked for, verbatim under the request's line
 * (ADR-0035). Waiting, it is whole: the pane scrolls, and the answer is about
 * exactly this. Settled, a long one is cut with the count of what is not shown.
 */
function approvalBodyLines(block: ApprovalBlock, cols: number): string[] {
  if (!block.body) return [];
  const lines = wrap(sanitize(block.body).replace(/\n+$/, '').replace(/\t/g, '    '), Math.max(1, cols - 4)).map((line) => `    ${line}`);
  if (block.status === 'pending' || lines.length <= SETTLED_BODY_LINES) return lines;
  const hidden = lines.length - SETTLED_BODY_LINES;
  return [...lines.slice(0, SETTLED_BODY_LINES), style.grey(`    … ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`)];
}

/** Keys first, so a narrow pane cuts the optional parts and never `ctrl-y`. */
function approvalKeysLine(block: ApprovalBlock, cols: number): string {
  const keys = ['ctrl-y allow', ...(block.allowForTask ? ['ctrl-t allow for task'] : []), 'ctrl-g deny (composer text is the note)'];
  return style.grey(truncate(`  ${keys.join(' · ')}`, cols));
}

/**
 * The checkpoint a task waits at, in full: it is a question to a person, so no
 * line of it is cut — a long one wraps and the pane scrolls. The keys come
 * after it, and say so when a tool request has to be answered first.
 */
export function checkpointCardLines(order: number, question: string, cols: number, approvalFirst: boolean, delegated = false): string[] {
  const room = Math.max(1, cols - 2);
  const first = approvalFirst ? wrap('answer the tool request above first (ctrl-y / ctrl-g), then:', room) : [];
  return [
    truncate(`${style.accent('◆')} ${style.bold(`Task ${order} asks`)}`, cols),
    ...wrap(sanitize(question).trim(), room).map((line) => `  ${line}`),
    ...first.map((line) => style.grey(`  ${line}`)),
    ...(delegated ? DELEGATED_CHOICES : CHECKPOINT_CHOICES).flatMap(([key, text]) => choiceLines(key, text, room)),
  ];
}

const CHECKPOINT_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['enter', 'reply: the task goes on with what you typed'],
  ['ctrl-y', 'approve as is'],
  ['ctrl-g', 'reject (with nothing typed, a plain no)'],
];
/** A delegated task's Approve can carry a raise (ADR-0056 M5). */
const DELEGATED_CHOICES: ReadonlyArray<readonly [string, string]> = CHECKPOINT_CHOICES.map(([key, text]) => (key === 'ctrl-y' ? [key, 'approve as is, or with a number typed here as a raise of its tokens'] : [key, text]));
const CHOICE_KEY_WIDTH = 6;

/** The key in the accent, then its meaning wrapped under itself, so a narrow pane never cuts either. */
function choiceLines(key: string, text: string, room: number): string[] {
  const hang = CHOICE_KEY_WIDTH + 2;
  const [head = '', ...rest] = wrap(text, Math.max(1, room - hang));
  return [
    `  ${style.accent(style.bold(pad(key, CHOICE_KEY_WIDTH)))}  ${style.grey(head)}`,
    ...rest.map((line) => `  ${' '.repeat(hang)}${style.grey(line)}`),
  ];
}

// ── A task's runner commands (#66) ───────────────────────────────────────────

const COMMAND_PAINT: Record<CommandStatus, Paint> = {
  running: style.yellow,
  done: style.green,
  failed: style.red,
  stopped: style.grey,
};

/** `❯ /name args  status`, and what a command that runs without the model printed hanging off `⎿`. */
function runnerCommandLines(block: CommandBlock, cols: number, detailAll: boolean): string[] {
  const typed = sanitize(`/${block.name}${block.args ? ` ${block.args}` : ''}`);
  const status = `  ${block.status}`;
  const head = `${style.accent('❯')} ${truncate(typed, Math.max(1, cols - 2 - width(status)))}${COMMAND_PAINT[block.status](status)}`;
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  const printed = shownOutput(block.output, detailAll ? DETAIL_LINES : PREVIEW_LINES, detailAll ? DETAIL_CHARS : PREVIEW_CHARS);
  const shown = detailAll
    ? printed.lines.flatMap((line) => wrap(sanitize(line), room))
    : printed.lines.map((line) => truncate(sanitize(line), room));
  const more = printed.hiddenLineCount > 0
    ? [style.grey(truncate(`… +${countOf(printed.hiddenLineCount, 'line')} ${detailAll ? 'not shown' : '(ctrl+o to expand)'}`, room))]
    : [];
  return [head, ...underHeader([...shown.map(style.grey), ...more])];
}

/**
 * One quiet line (ADR-0017), worded by core so every surface says the same.
 * A planner's condensed compaction keeps its summary behind full detail: it is
 * model-written, so it is painted as text and wrapped, never read as styling.
 */
function compactionLines(block: CompactionBlock, cols: number, detailAll: boolean): string[] {
  const hint = block.summary && !detailAll ? ' (ctrl+o for the summary)' : '';
  const head = style.grey(truncate(`≡ ${compactionText(block)}${hint}`, cols));
  if (!block.summary || !detailAll) return [head];
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  return [head, ...underHeader(block.summary.trim().split('\n').flatMap((line) => wrap(sanitize(line), room)).map(style.grey))];
}

/** One line unless the pane shows detail: what a user's own setup brought into the task is there to look up, not to read every time. */
function runnerLoadedLines(block: RunnerLoadedBlock, cols: number, detailAll: boolean): string[] {
  const of = (kind: RunnerLoadedBlock['commands'][number]['kind']) => block.commands.filter((c) => c.kind === kind).map((c) => `/${sanitize(c.name)}`);
  const skills = of('skill');
  const commands = of('command');
  const builtins = of('builtin');
  const counts = [
    countOf(skills.length, 'skill'), countOf(commands.length, 'command'), countOf(builtins.length, 'built-in command'), countOf(block.mcpServers.length, 'MCP server'),
  ];
  const head = truncate(`● Runner loaded ${counts.join(', ')}`, cols);
  const lines = [`${style.green('●')}${style.grey(head.slice(1))}`];
  if (!detailAll) return lines;
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  const list = (label: string, names: string[]) => (names.length > 0 ? wrap(`${label}: ${names.join(' ')}`, room) : []);
  const servers = block.mcpServers.map((m) => `${sanitize(m.name)}${m.status ? ` (${sanitize(m.status)})` : ''}`);
  return [
    ...lines,
    ...[...list('skills', skills), ...list('commands', commands), ...list('built-in', builtins), ...(servers.length > 0 ? wrap(`MCP servers: ${servers.join(', ')}`, room) : [])]
      .map((line) => OUTPUT_INDENT + style.grey(line)),
  ];
}

// ── A task's handoff (ADR-0047) ───────────────────────────────────────────────

const SEVERITY_PAINT: Record<FindingSeverity, Paint> = {
  blocker: style.red,
  major: style.yellow,
  minor: style.cyan,
  info: style.grey,
};

const HANDOFF_INDENT = '  ';
const FINDING_INDENT = '      ';

/** `F1 · Blocker · Title`, its title wrapped under itself so the id and severity stay on the first row. */
function findingHeadLines(f: HandoffFinding, cols: number): string[] {
  const id = sanitize(f.id);
  const severity = severityLabel(f.severity);
  const label = `${id} · ${severity} · `;
  const room = Math.max(1, cols - width(HANDOFF_INDENT) - width(label));
  return wrap(sanitize(f.title), room).map((line, i) => (i === 0
    ? `${HANDOFF_INDENT}${style.grey(id)} · ${SEVERITY_PAINT[f.severity](severity)} · ${line}`
    : `${HANDOFF_INDENT}${' '.repeat(width(label))}${line}`));
}

/** A finding whole: its id, severity and title, then its detail and evidence beneath it. */
function findingLines(f: HandoffFinding, cols: number): string[] {
  const room = Math.max(1, cols - FINDING_INDENT.length);
  const detail = f.detail
    ? sanitize(f.detail).replace(/\n+$/, '').split('\n').flatMap((line) => wrap(line, room)).map((line) => `${FINDING_INDENT}${line}`)
    : [];
  const evidence = f.evidence?.length
    ? wrap(`Evidence: ${f.evidence.map((e) => sanitize(handoffReferenceText(e))).join('; ')}`, room).map((line) => `${FINDING_INDENT}${style.grey(line)}`)
    : [];
  return [...findingHeadLines(f, cols), ...detail, ...evidence];
}

/** Each artifact as its own path or URL, so a reader can copy one without the others. A patch gets the expanded block below. */
function handoffArtifactLines(block: HandoffBlock, cols: number): string[] {
  const artifacts = block.handoff.artifacts?.filter((a) => a.kind !== 'patch') ?? [];
  if (artifacts.length === 0) return [];
  const room = Math.max(1, cols - FINDING_INDENT.length - 2);
  const rows = [`${HANDOFF_INDENT}${style.grey('Artifacts:')}`];
  for (const artifact of artifacts) {
    const [first, ...rest] = wrap(sanitize(handoffReferenceText(artifact)), room);
    rows.push(`${FINDING_INDENT}- ${first}`, ...rest.map((line) => `${FINDING_INDENT}  ${line}`));
  }
  return rows;
}

/**
 * A saved prototype in full (ADR-0050): what it changes, the commit it applies
 * to, the file to open, and every path it left out. The one-line artifact form
 * stays in the compact surfaces; this block is for the attempt's log.
 */
function handoffPatchLines(block: HandoffBlock, cols: number): string[] {
  const room = Math.max(1, cols - FINDING_INDENT.length);
  return savedPatchViews(block.handoff).flatMap((patch) => [
    ...wrap(`Patch: ${patch.changes}, ${patch.base}`, Math.max(1, cols - HANDOFF_INDENT.length))
      .map((line, i) => `${HANDOFF_INDENT}${i === 0 ? style.grey(line) : line}`),
    ...wrap(patch.saved, room).map((line) => `${FINDING_INDENT}${style.grey(line)}`),
    ...patch.flags.flatMap((flag) => wrap(flag, room).map((line) => `${FINDING_INDENT}${style.grey(line)}`)),
  ]);
}

/**
 * The long form, folded as a research report is: the first lines and a count,
 * or all of it under full detail with how to fold it back. The report stays in
 * the attempt's log, so this is the only place a surface reads it from.
 */
function handoffReportLines(report: string, cols: number, detailAll: boolean): string[] {
  const all = sanitize(report).replace(/\n+$/, '').split('\n');
  const shown = detailAll ? all : all.slice(0, REPORT_PREVIEW_LINES);
  const room = Math.max(1, cols - FINDING_INDENT.length);
  const rows = [
    `${HANDOFF_INDENT}${style.grey('Report:')}`,
    ...shown.flatMap((line) => wrap(line, room)).map((line) => `${FINDING_INDENT}${line}`),
  ];
  const hidden = all.length - shown.length;
  if (hidden > 0) rows.push(style.grey(`${FINDING_INDENT}… +${countOf(hidden, 'line')} of the report (ctrl+o to expand)`));
  else if (detailAll && all.length > REPORT_PREVIEW_LINES) rows.push(style.grey(`${FINDING_INDENT}… (ctrl+o to collapse)`));
  return rows;
}

function handoffLines(block: HandoffBlock, cols: number, detailAll: boolean): string[] {
  const { handoff } = block;
  const severity = worstSeverity(handoff.findings);
  const summary = handoff.findingCount > 0
    ? `${handoffFindingsText(handoff.findingCount)}${severity ? ` · ${severityLabel(severity).toLowerCase()}` : ''}`
    : null;
  const rows = [`${style.brand('◆')} ${style.bold('Handoff')}${summary ? style.grey(` · ${summary}`) : ''}`];
  if (handoff.commit) {
    const room = Math.max(1, cols - HANDOFF_INDENT.length);
    const body = handoff.commit.body ? sanitize(handoff.commit.body).trim() : '';
    rows.push(...wrap(`Commit: ${sanitize(handoff.commit.subject).trim()}`, room).map((line) => `${HANDOFF_INDENT}${style.bold(line)}`));
    if (body) rows.push(...body.split('\n').flatMap((line) => wrap(line, room)).map((line) => `${HANDOFF_INDENT}${line}`));
  }
  const said = sanitize(handoff.summary).trim();
  if (said) rows.push(...wrap(said, Math.max(1, cols - HANDOFF_INDENT.length)).map((line) => `${HANDOFF_INDENT}${line}`));
  if (handoff.findings.length > 0) {
    rows.push(`${HANDOFF_INDENT}${style.grey('Findings:')}`, ...handoff.findings.flatMap((f) => findingLines(f, cols)));
  }
  const more = handoff.findingCount - handoff.findings.length;
  if (more > 0) rows.push(style.grey(`${HANDOFF_INDENT}+${more} more finding${more === 1 ? '' : 's'}, in the attempt's log`));
  rows.push(...handoffArtifactLines(block, cols));
  rows.push(...handoffPatchLines(block, cols));
  if (handoff.report) rows.push(...handoffReportLines(handoff.report, cols, detailAll));
  return rows;
}

function planLine(block: PlanBlock, cols: number): string {
  const text = planMarkerParts(block).join(' · ');
  return `${style.brand('◇')}${truncate(`◇ ${text}`, cols).slice(1)}`;
}

function blockLines(block: DisplayBlock, cols: number, detailAll: boolean): string[] {
  switch (block.type) {
    case 'message':
      return (block.role === 'wake_up' ? reportUpdateLines(block, cols, detailAll) : null) ?? messageLines(block, cols);
    case 'thinking':
      return thinkingLines(block, cols, detailAll);
    case 'tool':
      return toolLines(block, cols, detailAll);
    case 'subagent':
      return subagentLines(block, cols, detailAll);
    case 'approval':
      return [approvalLine(block, cols), ...approvalBodyLines(block, cols)];
    case 'plan':
      return [planLine(block, cols)];
    case 'skill_load':
      return [skillLoadLine(block, cols)];
    case 'command':
      return runnerCommandLines(block, cols, detailAll);
    case 'compaction':
      return compactionLines(block, cols, detailAll);
    case 'runner_loaded':
      return runnerLoadedLines(block, cols, detailAll);
    case 'handoff':
      return handoffLines(block, cols, detailAll);
    // Pinned under the pane rather than drawn in it — see `tokenLine`.
    case 'usage':
      return [];
  }
}

// ── The pane ─────────────────────────────────────────────────────────────────

interface Drawn {
  cols: number;
  detailAll: boolean;
  lines: string[];
}

// Core hands back the same object for every block an input did not touch, so
// a streaming reply re-draws only itself — Markdown and wrapping are the cost
// of a frame, and a long conversation would otherwise pay it per delta.
const drawnBlocks = new WeakMap<DisplayBlock, Drawn>();

function drawn(block: DisplayBlock, cols: number, detailAll: boolean): string[] {
  const cached = drawnBlocks.get(block);
  if (cached && cached.cols === cols && cached.detailAll === detailAll) return cached.lines;
  const lines = blockLines(block, cols, detailAll);
  drawnBlocks.set(block, { cols, detailAll, lines });
  return lines;
}

/** The conversation as chat-pane lines, a blank line after each block; `answering` is the request the task view's keys answer, which carries them under it. The token line is not among them. */
export function conversationLines(blocks: readonly DisplayBlock[], cols: number, detailAll: boolean, answering?: ApprovalBlock): string[] {
  const lines: string[] = [];
  for (const [i, block] of blocks.entries()) {
    if (block.type === 'usage') continue;
    lines.push(...drawn(block, cols, detailAll));
    if (block === answering) lines.push(approvalKeysLine(block, cols));
    // A skill load sits right under the message that loaded it.
    if (blocks[i + 1]?.type !== 'skill_load') lines.push('');
  }
  return lines;
}

/**
 * The planner's context, live limits and reported cost as one compact row.
 * Nothing is drawn until one of them is known. Core words it, so every surface
 * agrees; the totals already count every subagent.
 */
export function tokenLine(blocks: readonly DisplayBlock[], cols: number, limits: readonly AccountLimitSnapshot[] = []): string | null {
  const usage = blocks[blocks.length - 1];
  const context = usage?.type === 'usage' ? contextMeterText(usage.contextFill) : null;
  const cost = usage?.type === 'usage' ? usageText({ totals: usage.totals }) : null;
  const text = [context ? `Planner ${context}` : null, ...limits.map(accountLimitsText), cost].filter(Boolean).join(' · ');
  return text ? style.grey(truncate(sanitize(text).replace(/\n/g, ' '), cols)) : null;
}

/** A flagged assignment and what it means for the task as it stands (core words it, so every surface agrees). */
export function assignmentFlagText(row: { assignmentFlag: string | null; assignmentConsequence: string | null }): string {
  return `${row.assignmentFlag} — ${row.assignmentConsequence}`;
}
