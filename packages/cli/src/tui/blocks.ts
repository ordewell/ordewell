import {
  diffRows, diffSummary, loadedSkillTokens, outputLines, outputPreview,
  type DiffRow, type DiffStat,
  type ApprovalBlock, type ApprovalKind, type ApprovalSource, type DisplayBlock, type MessageBlock, type MessageRole, type PlanBlock,
  type SkillLoadBlock, type SubagentBlock, type SubagentStatus, type ThinkingDisplayBlock, type ToolBlock,
} from '@ordewell/core';
import { sanitize, style, truncate, width, wrap, wrapLines } from './ansi';
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

/** The end of `text` that fits in `max` columns. */
function tailOf(text: string, max: number): string {
  const chars = [...text];
  let out = '';
  let used = 0;
  for (let i = chars.length - 1; i >= 0 && used + width(chars[i]) <= max; i--) {
    out = chars[i] + out;
    used += width(chars[i]);
  }
  return out;
}

// ── Messages and thinking ────────────────────────────────────────────────────

const ROLE_PREFIX: Record<MessageRole, Paint> = {
  user: (t) => `${style.cyan('❯')} ${t}`,
  planner: (t) => `${style.magenta('◆')} ${t}`,
  agent: (t) => `${style.magenta('◆')} ${t}`,
  system: (t) => style.grey(`· ${t}`),
  error: (t) => `${style.red('✗')} ${style.red(t)}`,
};

function messageLines(block: MessageBlock, cols: number): string[] {
  const text = sanitize(block.text);
  const room = Math.max(1, cols - 2);
  const wrapped = block.role === 'planner' || block.role === 'agent'
    ? renderMarkdown(text, room)
    : block.skills ? skillPaintedLines(text, block.skills, room) : wrap(text, room);
  return wrapped.map((line, i) => (i === 0 ? ROLE_PREFIX[block.role](line) : `  ${line}`));
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
      painted += line.slice(at, from) + style.cyan(line.slice(from, to));
      at = to;
    }
    return painted + line.slice(at);
  });
}

/** The path gives way first: it is the part a reader can do without. */
function skillLoadLine(block: SkillLoadBlock, cols: number): string {
  const head = `● /${sanitize(block.name)} skill loaded · `;
  const line = truncate(`${head}${truncatePath(sanitize(block.path), Math.max(1, cols - width(head)))}`, cols);
  return `${style.green('●')}${style.grey(line.slice(1))}`;
}

function thinkingLines(block: ThinkingDisplayBlock, cols: number, detailAll: boolean): string[] {
  const text = sanitize(block.text).trim();
  const head = `∴ Thinking (${countOf(text ? text.split(/\s+/).length : 0, 'word')})`;
  if (detailAll) {
    const body = text ? wrap(text, Math.max(1, cols - 2)).map((line) => style.grey(`  ${line}`)) : [];
    return [style.grey(truncate(head, cols)), ...body];
  }
  const latest = block.streaming ? (text.split('\n').at(-1) ?? '').trim() : '';
  const room = cols - width(`${head} · `);
  if (!latest || room < 2) return [style.grey(truncate(head, cols))];
  // A live line grows at its end, so a row too short for it keeps the end;
  // the ellipsis says the slice starts mid-sentence.
  const shown = width(latest) > room ? `…${tailOf(latest, room - 1)}` : latest;
  return [style.grey(`${head} · ${shown}`)];
}

// ── Command rows ─────────────────────────────────────────────────────────────

/** Rows under a command's header hang off `⎿`, and every row after the first keeps its indent. */
const OUTPUT_HEAD = '  ⎿  ';
const OUTPUT_INDENT = '     ';
const PREVIEW_LINES = 3;

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
  for (const char of Array.from(path).reverse()) {
    if (width(char + tail) > max - 1) break;
    tail = char + tail;
  }
  const slash = tail.indexOf('/');
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
  if (detailAll) {
    return wrap(`${name}(${keyArg})`, Math.max(1, cols - 2)).map((line, i) => (i === 0 ? `${commandMark(block)} ${line}` : `  ${line}`));
  }
  const open = `● ${name}(`;
  const room = cols - width(open) - 1;
  const cut = PATH_LIKE.test(keyArg) ? truncatePath(keyArg, room) : truncate(keyArg, room);
  const text = room > 1 ? `${open}${cut})` : truncate(`${open}${keyArg})`, cols);
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
 * hides, or one status line. In full detail: everything, wrapped.
 */
function resultLines(block: ToolBlock, room: number, detailAll: boolean): string[] {
  if (block.status === 'pending') return [style.grey('Running…')];
  const fit = (line: string): string[] => (detailAll ? wrap(line, room) : [truncate(line, room)]);
  const outcome = unsettledOutcome(block);
  if (outcome) {
    const [reason, ...rest] = outputLines(block.output).map(sanitize);
    const status = fit(reason ? `${outcome.label}: ${reason}` : outcome.label).map(outcome.paint);
    return detailAll ? [...status, ...rest.flatMap(fit).map(style.grey)] : status;
  }
  if (detailAll) {
    const lines = outputLines(block.output).map(sanitize);
    // The collapsed preview counts what it hides; the expanded view marks the
    // same rows with how to fold it back — the note flips rather than vanishes.
    const note = lines.length > PREVIEW_LINES ? ['… (ctrl+o to collapse)'] : [];
    return lines.length > 0 ? [...lines.flatMap(fit), ...note].map(style.grey) : [style.grey('(no output)')];
  }
  const { lines, hiddenLineCount } = outputPreview(block.output, PREVIEW_LINES);
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
  const rows = diffRows(block.output);
  const gutter = Math.max(0, ...rows.map((row) => String(row.line ?? '').length));
  const draw = (row: DiffRow): string[] => {
    const text = row.kind === 'gap' ? `${' '.repeat(gutter)} ⋮` : `${String(row.line ?? '').padStart(gutter)} ${DIFF_SIGN[row.kind]} ${sanitize(row.text)}`;
    return (detailAll ? wrap(text, room) : [truncate(text, room)]).map(DIFF_PAINT[row.kind]);
  };
  const shown = detailAll ? rows : rows.slice(0, DIFF_PREVIEW_ROWS);
  const hidden = rows.length - shown.length;
  const more = hidden > 0 ? [style.grey(`… +${countOf(hidden, 'line')} (ctrl+o to expand)`)] : [];
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
  const named = `${style.cyan('◆')}${head}${truncate(brief, briefRoom)}  ${SUBAGENT_PAINT[block.status](status)}`;
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

const APPROVAL_KIND: Record<ApprovalKind, string> = {
  shell_command: 'Run a command',
  url_fetch: 'Fetch a URL',
  external_path: 'Read outside the workspace',
  runner_tool: 'Use a tool',
};

// A request the user answered reads "Approved": naming `asked` would state the obvious.
const DECIDED_BY: Record<Exclude<ApprovalSource, 'asked'>, string> = {
  'pre-approved': 'pre-approved',
  remembered: 'remembered',
  mode: 'policy',
  'no-channel': 'no approval channel',
};

/** Status first, so a long subject is what the pane cuts. */
function approvalLine(block: ApprovalBlock, cols: number): string {
  const policy = block.decidedBy && block.decidedBy !== 'asked' ? DECIDED_BY[block.decidedBy] : undefined;
  const [mark, status, paint] = block.status === 'pending'
    ? ['?', 'Waiting for you', style.yellow]
    : block.status === 'granted'
      ? ['✓', policy ? `Auto-approved (${policy})` : block.forTask ? 'Approved for this task' : 'Approved', style.green]
      : block.status === 'withdrawn'
        ? ['·', 'Withdrawn', style.grey]
        : ['⊘', policy ? `Auto-denied (${policy})` : 'Denied', style.yellow];
  const note = block.note ? ` — “${firstLine(block.note)}”` : '';
  const line = `${mark} ${status} · ${APPROVAL_KIND[block.kind]}: ${firstLine(block.subject)}${note}`;
  return `${paint(mark)}${truncate(line, cols).slice(mark.length)}`;
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
export function checkpointCardLines(order: number, question: string, cols: number, approvalFirst: boolean): string[] {
  const room = Math.max(1, cols - 2);
  const keys = approvalFirst
    ? 'answer the tool request above first (ctrl-y / ctrl-g), then ctrl-y approves · ctrl-g rejects (composer text is the reason)'
    : 'ctrl-y approve · ctrl-g reject (composer text is the reason)';
  return [
    truncate(`${style.accent('◆')} ${style.bold(`Task ${order} asks`)}`, cols),
    ...wrap(sanitize(question).trim(), room).map((line) => `  ${line}`),
    ...wrap(keys, room).map((line) => style.grey(`  ${line}`)),
  ];
}

function planLine(block: PlanBlock, cols: number): string {
  const count = block.taskCount === undefined ? '' : ` (${countOf(block.taskCount, 'task')})`;
  const text = block.status === 'building' ? 'Building plan…' : `Plan ${block.status}${count}`;
  return `${style.cyan('◇')}${truncate(`◇ ${text}`, cols).slice(1)}`;
}

function blockLines(block: DisplayBlock, cols: number, detailAll: boolean): string[] {
  switch (block.type) {
    case 'message':
      return messageLines(block, cols);
    case 'thinking':
      return thinkingLines(block, cols, detailAll);
    case 'tool':
      return toolLines(block, cols, detailAll);
    case 'subagent':
      return subagentLines(block, cols, detailAll);
    case 'approval':
      return [approvalLine(block, cols)];
    case 'plan':
      return [planLine(block, cols)];
    case 'skill_load':
      return [skillLoadLine(block, cols)];
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

function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const [value, unit] = n < 999_950 ? [n / 1000, 'k'] : [n / 1_000_000, 'M'];
  return `${value.toFixed(1).replace(/\.0$/, '')}${unit}`;
}

/** Four decimals at most, two at least: a session can cost a fraction of a cent or several dollars. */
function formatCost(currency: string, amount: number): string {
  const [whole, frac = ''] = amount.toFixed(4).replace(/0+$/, '').split('.');
  const value = `${whole}.${frac.padEnd(2, '0')}`;
  return currency.toLowerCase() === 'usd' ? `$${value}` : `${value} ${currency.toUpperCase()}`;
}

/**
 * The session's usage as one row — `12.4k in · 3.1k out · 18% ctx` — or null
 * before anything was reported. The totals already count every subagent, and
 * a cost appears only as a provider or runner reported it.
 */
export function tokenLine(blocks: readonly DisplayBlock[], cols: number): string | null {
  const usage = blocks[blocks.length - 1];
  if (usage?.type !== 'usage') return null;
  const { totals, contextFill } = usage;
  const parts = [
    ...(totals.inputTokens !== undefined ? [`${compactCount(totals.inputTokens)} in`] : []),
    ...(totals.outputTokens !== undefined ? [`${compactCount(totals.outputTokens)} out`] : []),
    ...(contextFill ? [`${Math.round((contextFill.usedTokens / contextFill.windowTokens) * 100)}% ctx`] : []),
    ...Object.entries(totals.reportedCost ?? {}).map(([currency, amount]) => formatCost(currency, amount)),
  ];
  return parts.length > 0 ? style.grey(truncate(parts.join(' · '), cols)) : null;
}
