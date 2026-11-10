import type { UsageRecord } from '../models/Usage';
import { RECOVERABLE_READ_TOOLS, type CompactableMessage } from './contextCompaction';
import { currentPlanBlock, extractSummary, HISTORY_KEEPS, SUMMARY_KEEPS, SUMMARY_TAGS } from './conversationSummary';
import { PLANNER_TASK_READ_TOOLS } from './mcp/tools';
import { CONTEXT_BUDGET, callBudget, replyTokens, type ModelLimits } from './plannerContextBudget';

/**
 * How an API planner's context is condensed into a summary (ADR-0002): by its
 * own provider, model and credentials, in calls that offer no tools and
 * whose reply is only ever read as text — nothing a summary call says can run
 * a tool or change the plan. What it may not leave to the model it does not
 * ask of it: the calls a turn already made that changed something are listed
 * from the messages themselves, and task state is the current plan's.
 */

export const SUMMARY_LIMITS = {
  /** The longest summary asked for: a summary is a small part of the window, not a second transcript. */
  maxOutputTokens: 4_096,
  /** ...and no more than this share of the prompt a call may carry, so a small window keeps room for what it is kept with. */
  shareOfCeiling: 0.1,
  /** The shortest a summary is asked for, however small the window. */
  minOutputTokens: 256,
  /**
   * Calls one summary may take when what it condenses does not fit one: each
   * folds a part into the summary so far. Bounded, because every one is paid
   * for, and a context that needs more is better paused than half condensed.
   */
  maxPasses: 8,
  /** A part smaller than this beside the summary so far is not worth a call: the window is too small to condense in. */
  minPartChars: 2_000,
  /** A summary shorter than this many words — or a quarter of what it condensed, if that is less — cannot stand for it. */
  minWords: 12,
  /** A summary at or past this share of what it condensed, once that is a part's worth, did not condense it. */
  maxShareOfInput: 0.6,
  /** What a call's arguments and a result's head are cut to in the list of calls not to repeat. */
  ledgerArgsChars: 300,
  ledgerResultChars: 200,
};

/** One summary call: instructions and the text to condense in, the reply's text out. */
export interface SummaryCallRequest {
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface SummaryReply {
  text: string;
  /** 'length' when the output limit cut the reply off. */
  finishReason?: string;
}

/**
 * A call on the planner's own provider, model and credentials that offers no
 * tools. It reports what the provider measured through `onUsage`, which the
 * caller marks as no measure of the planner's live context.
 */
export type SummaryCall = (request: SummaryCallRequest, onUsage: (record: UsageRecord) => void) => Promise<SummaryReply>;

/** What a summary may take and give, on the model it is written by. */
export interface SummaryLimits {
  /** Characters one call may carry, its instructions included. */
  inputChars: number;
  maxOutputTokens: number;
  /** Characters taken as one token: the same estimate the planner's calls are budgeted on. */
  charsPerToken: number;
}

/**
 * A summary could not be written, or was not fit to stand in for what it
 * condensed. Nothing was committed: what it was to replace stays as it was.
 */
export class ContextSummaryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContextSummaryError';
  }
}

/** The reply a summary asks for on a model: its share of the window, within the provider's cap. */
export function summaryReplyTokens(limits: ModelLimits | undefined, wanted: number): number {
  const ceiling = callBudget(limits, wanted)?.ceiling;
  const share = ceiling === undefined ? Infinity : Math.floor(ceiling * SUMMARY_LIMITS.shareOfCeiling);
  return Math.min(replyTokens(limits, wanted), SUMMARY_LIMITS.maxOutputTokens, Math.max(SUMMARY_LIMITS.minOutputTokens, share));
}

/**
 * A summary's limits on a model: what one call may carry is the same 90% of
 * its window a planner call may fill, less the summary's own reply. Unknown
 * window: one call carries everything, as nothing says it cannot.
 */
export function summaryLimits(limits: ModelLimits | undefined, wanted: number, charsPerToken: number): SummaryLimits {
  const maxOutputTokens = summaryReplyTokens(limits, wanted);
  const ceiling = callBudget(limits, maxOutputTokens)?.ceiling;
  return { inputChars: ceiling === undefined ? Infinity : Math.floor(ceiling * charsPerToken), maxOutputTokens, charsPerToken };
}

/** What is condensed: history that landed before the open turn, or the open turn's own older rounds. */
export type SummarySubject = 'history' | 'turn';

export interface CondenseRequest {
  model: string;
  subject: SummarySubject;
  messages: readonly CompactableMessage[];
  /** The current plan's lines, which the summary is told outrank anything it says of task state. */
  planLines?: readonly string[] | null;
  limits: SummaryLimits;
  signal?: AbortSignal;
  /**
   * Whether what the summary is for still stands — the turn, the model, the
   * live context it was asked of — read after every call, so a late reply is
   * refused rather than committed.
   */
  current: () => boolean;
  onUsage: (record: UsageRecord) => void;
}

/**
 * Condense `messages` into a summary, validated before it is returned. What
 * one call cannot carry is folded in parts, each into the summary so far, in
 * at most {@link SUMMARY_LIMITS.maxPasses} calls. A stop, a change under it
 * or a reply that is not a whole, real summary ends it with nothing to show.
 */
export async function condense(call: SummaryCall, request: CondenseRequest): Promise<string> {
  const { limits, signal } = request;
  const instructions = summaryInstructions(request.subject, request.planLines ?? null);
  const allowance = Math.ceil(limits.maxOutputTokens * limits.charsPerToken);
  const partChars = limits.inputChars - instructions.length - allowance - PART_FRAME_CHARS;
  if (partChars < SUMMARY_LIMITS.minPartChars) {
    throw new ContextSummaryError(`${request.model}'s window leaves no room to condense the conversation in.`);
  }
  const parts = pack(renderMessages(request.messages), partChars);
  if (parts.length > SUMMARY_LIMITS.maxPasses) {
    throw new ContextSummaryError(`The context is too long to condense in ${SUMMARY_LIMITS.maxPasses} summary calls on ${request.model}.`);
  }
  let summary: string | null = null;
  for (const [i, part] of parts.entries()) {
    const input = foldInput(summary, part, i, parts.length);
    const reply = await call({ model: request.model, instructions, input, maxOutputTokens: limits.maxOutputTokens, signal }, request.onUsage);
    if (signal?.aborted) throw new DOMException('Condensing was stopped.', 'AbortError');
    if (!request.current()) throw new ContextSummaryError('The context changed while it was being condensed.');
    summary = validated(reply, input, limits);
  }
  if (summary === null) throw new ContextSummaryError('There was nothing to condense.');
  return summary;
}

const PART_FRAME_CHARS = 200;

function foldInput(summary: string | null, part: string, i: number, of: number): string {
  const framed = of === 1 ? `<conversation>\n${part}\n</conversation>` : `<conversation_part number="${i + 1}" of="${of}">\n${part}\n</conversation_part>`;
  return summary === null ? framed : `<summary_so_far>\n${summary}\n</summary_so_far>\n\n${framed}`;
}

/**
 * A reply that can stand in for what it condensed, or the reason it cannot.
 * The tags prove only that the reply was not cut off before them; what is
 * inside them must also be a summary: long enough to carry something, short
 * enough to have condensed it, and not a refusal — each judged against what
 * it condensed, so a short conversation may have a short summary.
 */
function validated(reply: SummaryReply, input: string, limits: SummaryLimits): string {
  if (reply.finishReason === 'length') throw new ContextSummaryError('The summary was cut off by its output limit.');
  const summary = extractSummary(reply.text);
  if (!summary) throw new ContextSummaryError('The reply held no complete summary.');
  const wanted = Math.min(SUMMARY_LIMITS.minWords, Math.ceil(wordsUpTo(input, SUMMARY_LIMITS.minWords * 4) / 4));
  if (wordsUpTo(summary, wanted) < wanted) throw new ContextSummaryError('The summary was too short to stand for what it condensed.');
  if (REFUSAL.test(summary)) throw new ContextSummaryError('The model declined to write the summary.');
  if (input.length >= SUMMARY_LIMITS.minPartChars && summary.length >= input.length * SUMMARY_LIMITS.maxShareOfInput) {
    throw new ContextSummaryError('The summary did not condense what it was given.');
  }
  // A provider that ignores the requested limit sends more than the room kept for it.
  if (summary.length > limits.maxOutputTokens * CONTEXT_BUDGET.maxCharsPerToken) throw new ContextSummaryError('The summary ran past the room kept for it.');
  return summary;
}

const REFUSAL = /^(i'?m sorry|sorry,|i can(not|'t)|i am unable|as an ai)\b/i;

/** The words in `text`, counted no further than `limit`: what is judged never needs more. */
function wordsUpTo(text: string, limit: number): number {
  const word = /\S+/g;
  let n = 0;
  while (n < limit && word.exec(text)) n++;
  return n;
}

/** Blocks the planner is sent every turn that a summary need not carry: the current plan is given beside it, and the catalog is the session's. */
const ELIDED: ReadonlyArray<[RegExp, string]> = [
  [/<available_models>[\s\S]*?<\/available_models>/g, '[model catalog omitted]'],
  [/<current_plan>[\s\S]*?<\/current_plan>/g, '[plan block omitted: the current plan is given separately]'],
];

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/** Each message as the summary call reads it: who said it, and what — a call by its name and arguments, a result by the call it answers. */
export function renderMessages(messages: readonly CompactableMessage[]): string[] {
  const names = new Map<string, string>();
  return messages.flatMap((m): string[] => {
    if (m.role === 'tool') return [`[${names.get(m.tool_call_id ?? '') ?? 'tool'} result]\n${text(m.content)}`];
    const said = ELIDED.reduce((t, [pattern, marker]) => t.replace(pattern, marker), text(m.content)).trim();
    const calls = (m.tool_calls ?? []).map((call) => {
      if (call.id && call.function?.name) names.set(call.id, call.function.name);
      return `[planner called ${call.function?.name ?? 'a tool'}(${call.function?.arguments ?? ''})]`;
    });
    const who = m.role === 'assistant' ? 'planner' : m.role;
    const body = [said, ...calls].filter(Boolean).join('\n');
    return body ? [`[${who}]\n${body}`] : [];
  });
}

/** Rendered messages packed into parts of at most `max` characters, message boundaries kept where a message fits. */
function pack(blocks: readonly string[], max: number): string[] {
  const parts: string[] = [];
  let current = '';
  const flush = () => { if (current) parts.push(current); current = ''; };
  for (const block of blocks) {
    if (block.length > max) {
      flush();
      for (let at = 0; at < block.length; at += max) parts.push(block.slice(at, at + max));
      continue;
    }
    if (current.length + block.length + 2 > max) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();
  return parts;
}

/** Reads a stub or a second call does no harm to: everything else a call does is listed as done. */
const REPEATABLE_READS: ReadonlySet<string> = new Set([...RECOVERABLE_READ_TOOLS, ...PLANNER_TASK_READ_TOOLS.map((t) => t.name)]);

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface EffectCall {
  name: string;
  args: string;
  /** The head of what it returned. */
  outcome: string;
}

/**
 * The calls in `messages` that changed something, or that the user may have
 * been asked to approve — commands, web reads, subagents, execution tools —
 * read off the messages rather than asked of the model, so they are exactly
 * the ones it made.
 */
function effectCalls(messages: readonly CompactableMessage[]): EffectCall[] {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, text(m.content));
  return messages.flatMap((m) => (m.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (!name || REPEATABLE_READS.has(name)) return [];
    const result = call.id !== undefined ? results.get(call.id) : undefined;
    const outcome = result === undefined ? 'no result recorded' : oneLine(result, SUMMARY_LIMITS.ledgerResultChars);
    return [{ name, args: call.function?.arguments ?? '', outcome }];
  }));
}

/** {@link effectCalls} as lines: each call with its arguments and the head of what it returned. */
export function effectLedger(messages: readonly CompactableMessage[]): string[] {
  return effectCalls(messages).map(({ name, args, outcome }) => `- ${name}(${oneLine(args, SUMMARY_LIMITS.ledgerArgsChars)}) → ${outcome}`);
}

/** {@link effectCalls} keyed by {@link callKey}, each to the head of what it returned. */
export function effectReceipts(messages: readonly CompactableMessage[]): Array<[key: string, outcome: string]> {
  return effectCalls(messages).map(({ name, args, outcome }) => [callKey(name, args), outcome]);
}

/** One call as a receipt knows it: its tool and its arguments, whatever order the model wrote their keys in. */
export function callKey(name: string, args: string | Readonly<Record<string, unknown>>): string {
  if (typeof args !== 'string') return `${name}\u0000${canonicalJson(args)}`;
  try {
    return `${name}\u0000${canonicalJson(JSON.parse(args))}`;
  } catch {
    return `${name}\u0000${args}`;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The note that stands in a turn's live context for its condensed rounds,
 * between the user's message and the rounds kept as they were.
 */
export function turnProgressNote(summary: string, ledger: readonly string[]): string {
  return [
    '[Context note from Ordewell] The earlier rounds of this turn were condensed to make room in your context. The message above is the user\'s, unchanged; the newest rounds follow as they were.',
    '<turn_progress>',
    summary,
    '</turn_progress>',
    ...(ledger.length > 0 ? [
      'Already done in this turn — do not make these calls again; what each returned is as shown:',
      ...ledger,
    ] : []),
  ].join('\n');
}

function summaryInstructions(subject: SummarySubject, planLines: readonly string[] | null): string {
  const common = [
    ...SUMMARY_KEEPS,
    'Write plain prose or short lists. Do not address the user, do not call tools, and do not write task operations or plan JSON: nothing you write is acted on.',
    'When a summary so far is given, fold the new part into it: the result must stand for both.',
    SUMMARY_TAGS,
    ...currentPlanBlock(planLines),
  ];
  if (subject === 'turn') {
    return [
      'You condense the earlier rounds of a planner\'s current turn. The planner researches a code repository and plans tasks for coding agents; its turn answers the user\'s message, which stays in its context unchanged, as do its newest rounds. Your summary sits between them, so the planner can carry on the turn from it.',
      'Keep: what it looked up and what it found; what it decided and why; what it did and what came of it; what it still means to do to answer the user\'s message.',
      'The calls that changed something are listed for the planner separately, and it is told not to make them again: state what came of each accurately.',
      ...common,
    ].join('\n');
  }
  return [
    'You condense the earlier part of a planning conversation between a user and a planner, an assistant that researches a code repository and plans tasks for coding agents. Your summary replaces that part in the planner\'s context, so the planner must be able to carry on from it alone.',
    HISTORY_KEEPS,
    ...common,
  ].join('\n');
}
