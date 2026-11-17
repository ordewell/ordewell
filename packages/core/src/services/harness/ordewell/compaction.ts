import type { AgentEvent } from '../AgentAdapter';
import type { UsageRecord } from '../../../models/Usage';
import type { ModelClient, ModelMessage, ModelRequest, ModelUsage, SystemPart, ToolDefinition } from '../../model';
import type { ModelInfo } from './models';
import type { CompactionEntry, LoadedTranscript, TranscriptStore } from './transcript';
import { clampTaskCompactAt, type TaskCompactAt } from '../../taskCompactWindow';

/**
 * Context compaction for the built-in runner (ADR-0070): spend fewer tokens
 * without losing the task. When the next prompt would not leave room to work,
 * the middle of the conversation is replaced by a model-written summary. The
 * task message (its prompt and the earlier tasks' handoffs) and the newest
 * messages stay word for word. The compacted conversation is one transcript
 * line, so a resume continues from it.
 */

/** Room left for the next reply and the next tool results: 15% of the window, never under 16k tokens. */
export const RESERVE_FRACTION = 0.15;
export const RESERVE_MIN_TOKENS = 16_000;

/**
 * A compaction that would start below this share of the window is not one:
 * with a window under about 32k the reserve alone is the whole window, and
 * compacting on every step would leave no conversation to keep.
 */
const THRESHOLD_FLOOR_FRACTION = 0.5;

/** How much of the window the verbatim tail may take. */
export const TAIL_FRACTION = 0.25;

/** The shares of the window an overflow retry shrinks the request to, tried in order (then it fails). */
export const OVERFLOW_FRACTIONS: readonly number[] = [0.85, 0.7, 0.5, 0.35];

/** A provider's tokens are about this many characters of English or code; counting high compacts early rather than overflowing. */
const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_CHARS = 12;

/** The longest summary asked for, and the least a summary is assumed to take when sizing what is left. */
const SUMMARY_MAX_OUTPUT_TOKENS = 8_000;

/** Messages a failed proactive compaction waits out before it is tried again. */
const RETRY_AFTER_MESSAGES = 8;

export function compactionReserve(contextWindow: number): number {
  return Math.max(RESERVE_MIN_TOKENS, Math.ceil(contextWindow * RESERVE_FRACTION));
}

/** The estimated prompt size above which the conversation is compacted before the next request. */
export function compactionThreshold(contextWindow: number): number {
  return Math.max(contextWindow - compactionReserve(contextWindow), Math.floor(contextWindow * THRESHOLD_FLOOR_FRACTION));
}

export function shouldCompact(estimatedPrompt: number, contextWindow: number, startAt?: number): boolean {
  return estimatedPrompt > Math.min(startAt ?? Infinity, compactionThreshold(contextWindow));
}

/**
 * The least context a set start size compacts from. Below it what a compaction
 * keeps (the system prompt and tools, the task message, a summary of up to
 * {@link SUMMARY_MAX_OUTPUT_TOKENS} and a verbatim tail) would leave too little
 * room under the start to work in before the next one.
 */
export const COMPACT_AT_MIN_TOKENS = 32_000;

/**
 * Where a task on this runner starts compacting under `taskCompactAt`. `auto`
 * is the capacity guard ({@link compactionThreshold}); a number is held
 * between {@link COMPACT_AT_MIN_TOKENS} and that guard, with one line to `log`
 * when it moves. `off` cannot mean no compaction: the loop is Ordewell's own,
 * and with nothing compacting it would run into the provider's overflow
 * error, so it is `auto`, said in one line.
 */
export function compactionStart(window: number, at: TaskCompactAt, runner: string, log: (line: string) => void): number {
  const guard = compactionThreshold(window);
  if (at === 'off') {
    log(`${runner}: taskCompactAt off is not honoured: without compaction this runner would run into the provider's context limit, so it compacts as auto does, from ${guard} tokens.`);
  }
  if (typeof at !== 'number') return guard;
  return clampTaskCompactAt(at, { min: Math.min(COMPACT_AT_MIN_TOKENS, guard), max: guard }, runner, log);
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function messageChars(message: ModelMessage): number {
  let chars = MESSAGE_OVERHEAD_CHARS;
  if (message.role === 'tool') {
    for (const result of message.results) chars += result.callId.length + result.name.length + result.output.length;
    return chars;
  }
  chars += message.text.length;
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? []) chars += call.id.length + call.name.length + call.rawArguments.length;
    if (message.providerState) chars += JSON.stringify(message.providerState).length;
  }
  return chars;
}

export function estimateMessageTokens(message: ModelMessage): number {
  return estimateTokens(messageChars(message));
}

/** The tokens the system prompt and tool list take on every request. */
export function estimateFixedTokens(system: readonly SystemPart[], tools: readonly ToolDefinition[]): number {
  return estimateTokens(system.reduce((sum, part) => sum + part.text.length, 0) + JSON.stringify(tools).length);
}

/**
 * The next prompt's size: the provider's own count of the last request and its
 * reply, plus an estimate of everything recorded since. With no count (a fresh
 * attempt, or the step after a compaction) the whole prompt is estimated.
 */
export function estimatePromptTokens(transcript: Readonly<LoadedTranscript>, fixedTokens: number): number {
  const { measured, messages } = transcript;
  if (measured && measured.covers <= messages.length) {
    return measured.tokens + sumTokens(messages.slice(measured.covers));
  }
  return fixedTokens + sumTokens(messages);
}

function sumTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export interface TailSplit {
  /** Leading messages kept word for word: the task message. */
  head: number;
  /** The first message of the verbatim tail; `head`..`tailFrom` is what a summary replaces. */
  tailFrom: number;
}

/**
 * Where the conversation is cut. The head is the task message. The tail starts
 * at a user message when one leaves the tail within `tailBudget`, else at an
 * assistant message, and never at a tool result, so a call is never apart from
 * its result. The earliest such start that fits is taken, to keep the most.
 * Unless `allowEmptyTail`, the newest start is kept even over budget: the
 * model is acting on its last step, and a summary is no substitute for it.
 * Nothing between head and tail means there is nothing to compact.
 */
export function splitForCompaction(
  messages: readonly ModelMessage[],
  tailBudget: number,
  options: { allowEmptyTail?: boolean } = {},
): TailSplit | undefined {
  const head = messages[0]?.role === 'user' ? 1 : 0;
  const suffix: number[] = new Array<number>(messages.length + 1).fill(0);
  for (let i = messages.length - 1; i >= 0; i--) suffix[i] = (suffix[i + 1] ?? 0) + estimateMessageTokens(messages[i] as ModelMessage);

  const starts = (role: ModelMessage['role']): number[] => messages.flatMap((message, i) => (i >= head && message.role === role ? [i] : []));
  const users = starts('user');
  const assistants = starts('assistant');
  let tailFrom = users.find((i) => (suffix[i] ?? 0) <= tailBudget) ?? assistants.find((i) => (suffix[i] ?? 0) <= tailBudget);
  if (tailFrom === undefined) {
    tailFrom = options.allowEmptyTail ? messages.length : Math.max(users.at(-1) ?? head, assistants.at(-1) ?? head);
  }
  return tailFrom > head ? { head, tailFrom } : undefined;
}

// ─── The summary ────────────────────────────────────────────────────────────

/** The headings every summary has, in order; `level` is the markdown depth. */
export const SUMMARY_HEADINGS: readonly { name: string; level: 2 | 3 }[] = [
  { name: 'Objective', level: 2 },
  { name: 'Requirements', level: 2 },
  { name: 'Decisions', level: 2 },
  { name: 'Work State', level: 2 },
  { name: 'Completed', level: 3 },
  { name: 'Active', level: 3 },
  { name: 'Blocked', level: 3 },
  { name: 'Next Move', level: 2 },
  { name: 'Relevant Files', level: 2 },
  { name: 'Important Context', level: 2 },
];

const HEADING_LINE = /^\s{0,3}#{1,6}\s*(.*?)\s*:?\s*#*\s*$/;

function headingName(line: string): string | undefined {
  const text = HEADING_LINE.exec(line)?.[1]?.toLowerCase();
  return SUMMARY_HEADINGS.find((heading) => heading.name.toLowerCase() === text)?.name;
}

export function missingHeadings(summary: string): string[] {
  const present = new Set(summary.split('\n').flatMap((line) => headingName(line) ?? []));
  return SUMMARY_HEADINGS.filter((heading) => !present.has(heading.name)).map((heading) => heading.name);
}

const NOT_RECORDED = '(not recorded)';

/**
 * The summary with every heading, in order and at its level. A model that
 * still leaves one out after its reminder gets it filled with a plain "not
 * recorded", so what the next step reads always has the same shape.
 */
export function normalizeSummary(summary: string): string {
  const sections = new Map<string, string[]>();
  const preamble: string[] = [];
  let current: string[] = preamble;
  for (const line of summary.trim().split('\n')) {
    const name = headingName(line);
    if (name !== undefined && !sections.has(name)) {
      current = [];
      sections.set(name, current);
    } else {
      current.push(line);
    }
  }
  // Words before the first heading are still the model's, so they open the objective.
  const objective = sections.get('Objective');
  if (preamble.some((line) => line.trim() !== '')) {
    if (objective) objective.unshift(...preamble);
    else sections.set('Objective', preamble);
  }
  return SUMMARY_HEADINGS.map((heading) => {
    const body = (sections.get(heading.name) ?? []).join('\n').trim();
    return `${'#'.repeat(heading.level)} ${heading.name}\n${body === '' ? NOT_RECORDED : body}`;
  }).join('\n\n');
}

const SUMMARY_SYSTEM = [
  'You write the working memory of a coding agent whose context is being compacted. The agent will continue its task from your summary and the most recent messages alone, so anything you leave out is lost to it.',
  'Write the summary in exactly these markdown sections, in this order, with these headings:',
  ...SUMMARY_HEADINGS.map((heading) => `${'#'.repeat(heading.level)} ${heading.name}`),
  'Objective: what the task asks, in the task message\'s own terms. Requirements: every constraint and acceptance condition stated, by the task or the user. Decisions: choices made and why, including approaches ruled out. Work State: Completed (what is done and verified, with the command and result), Active (what is in progress and its state), Blocked (what is stuck and on what). Next Move: the single next action. Relevant Files: paths with one line each on what matters there (changed, read, still to change). Important Context: facts the agent would otherwise have to rediscover (error messages, command lines, values, names, outputs it depends on).',
  'Be specific and keep exact identifiers, paths, commands and numbers. Do not invent work that was not done. If the conversation begins with an earlier summary, carry forward what is still true. Write only the summary, with no preface.',
].join('\n\n');

const FILE_TAIL = '[output truncated]';

/** The conversation as plain text for the summary call: no tool calls, so the call needs no tool list. */
export function renderConversation(messages: readonly ModelMessage[], maxResultChars: number): string {
  const clip = (text: string): string => (text.length > maxResultChars ? `${text.slice(0, maxResultChars)}\n${FILE_TAIL}` : text);
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      blocks.push(`[user]\n${message.text}`);
    } else if (message.role === 'assistant') {
      const calls = (message.toolCalls ?? []).map((call) => `[tool call ${call.name}] ${clip(call.rawArguments)}`);
      blocks.push([`[assistant]${message.text ? `\n${message.text}` : ''}`, ...calls].join('\n'));
    } else {
      for (const result of message.results) {
        blocks.push(`[tool result ${result.name}${result.isError ? ' (error)' : ''}]\n${clip(result.output)}`);
      }
    }
  }
  return blocks.join('\n\n');
}

/**
 * The rendering that fits `maxChars`: tool output is clipped harder until it
 * does, and then the oldest part is dropped, since a summary of the newest
 * part of a long middle serves the task better than a failed call.
 */
function fitConversation(messages: readonly ModelMessage[], maxChars: number): string {
  for (const cap of [4_000, 1_500, 500, 150]) {
    const text = renderConversation(messages, cap);
    if (text.length <= maxChars) return text;
  }
  const text = renderConversation(messages, 150);
  return `[earlier conversation omitted]\n${text.slice(text.length - maxChars)}`;
}

function summaryRequest(model: ModelInfo, conversation: string, followUps: readonly ModelMessage[]): ModelRequest {
  const task = `Here is the part of the conversation to summarize.\n\n<conversation>\n${conversation}\n</conversation>\n\nWrite the summary now, with every heading.`;
  return {
    model: model.model,
    system: [{ text: SUMMARY_SYSTEM }],
    messages: [{ role: 'user', text: task }, ...followUps],
    tools: [],
    maxOutputTokens: Math.min(model.maxOutputTokens, SUMMARY_MAX_OUTPUT_TOKENS),
  };
}

async function collect(client: ModelClient, request: ModelRequest, signal: AbortSignal | undefined): Promise<{ text: string; usage?: ModelUsage }> {
  let text = '';
  let usage: ModelUsage | undefined;
  for await (const event of client.stream(request, signal)) {
    if (event.type === 'text-delta') text += event.text;
    else if (event.type === 'usage') usage = event.usage;
  }
  return { text, ...(usage ? { usage } : {}) };
}

function addUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage | undefined {
  if (!a || !b) return a ?? b;
  const sum = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const out: ModelUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
    const value = sum(a[key], b[key]);
    if (value !== undefined) out[key] = value;
  }
  if (a.cost && b.cost && a.cost.currency === b.cost.currency) out.cost = { amount: a.cost.amount + b.cost.amount, currency: a.cost.currency };
  else if (a.cost ?? b.cost) out.cost = (a.cost ?? b.cost) as NonNullable<ModelUsage['cost']>;
  return out;
}

/**
 * One summary of `middle`: a call with no tools, and one reminder if a heading
 * is missing. An empty reply is an error, not a summary.
 */
export async function summarize(
  client: ModelClient,
  model: ModelInfo,
  middle: readonly ModelMessage[],
  options: { maxInputChars: number; signal?: AbortSignal },
): Promise<{ summary: string; usage?: ModelUsage }> {
  const request = summaryRequest(model, fitConversation(middle, options.maxInputChars), []);
  const first = await collect(client, request, options.signal);
  if (first.text.trim() === '') throw new Error('The model returned an empty summary.');
  let usage = first.usage;
  let text = first.text;
  const missing = missingHeadings(text);
  if (missing.length > 0) {
    const reminder: ModelMessage = {
      role: 'user',
      text: `Your summary is missing these headings: ${missing.join(', ')}. Write the whole summary again, with every required heading in order.`,
    };
    const second = await collect(client, { ...request, messages: [...request.messages, { role: 'assistant', text: first.text }, reminder] }, options.signal);
    usage = addUsage(usage, second.usage);
    if (second.text.trim() !== '') text = second.text;
  }
  return { summary: normalizeSummary(text), ...(usage ? { usage } : {}) };
}

const SUMMARY_PREFIX = 'Your context was compacted.';

/** The user message the summary becomes: said once, so a later reader knows what it stands for. */
export function summaryMessage(summary: string): Extract<ModelMessage, { role: 'user' }> {
  return {
    role: 'user',
    text: [
      `${SUMMARY_PREFIX} The task message above and the most recent messages below are exact; this summary, written from the messages between them, replaces them.`,
      '<summary>',
      summary,
      '</summary>',
      'Continue the task from "Next Move", and re-read a file before relying on a remembered detail of it.',
    ].join('\n'),
  };
}

function isSummaryMessage(message: ModelMessage | undefined): boolean {
  return message?.role === 'user' && message.text.startsWith(SUMMARY_PREFIX);
}

// ─── The compactor ──────────────────────────────────────────────────────────

export interface CompactorOptions {
  client: ModelClient;
  model: ModelInfo;
  store: TranscriptStore;
  /** The system prompt and tool list every request carries, which count toward the window. */
  tools: readonly ToolDefinition[];
  fallbackSystem: readonly SystemPart[];
  /** Writes a transcript line, secrets redacted (ADR-0061). */
  record: (entry: CompactionEntry) => Promise<void>;
  emit: (event: AgentEvent) => void;
  /** Where a set `taskCompactAt` starts compaction, already held within bounds ({@link compactionStart}); the guard alone when absent. */
  startAt?: number;
}

/** The compaction the loop asks for; each applies to the transcript just loaded. */
export class Compactor {
  /** Messages a failed or fruitless attempt must wait for before the next proactive one. */
  private retryAt = 0;
  /** The step whose compaction was last announced: another in the same step only moves the meter. */
  private announcedStep: number | undefined;
  /**
   * The window this attempt runs under: the model's, until the provider
   * refuses a request as too long. A shrink that let the request through
   * keeps its smaller window for the rest of the attempt, so the next steps
   * compact before they reach the size that was refused (ADR-0070).
   */
  private effectiveWindow: number;

  constructor(private readonly options: CompactorOptions) {
    this.effectiveWindow = options.model.contextWindow;
  }

  /** The window the meter and the next compaction measure against. */
  get contextWindow(): number {
    return this.effectiveWindow;
  }

  /**
   * Where a set start now has compaction begin: the start, or the guard of a
   * window an overflow left smaller, whichever is lower. Undefined with no
   * start set, where the guard alone decides (ADR-0018 C4).
   */
  get startTokens(): number | undefined {
    const { startAt } = this.options;
    return startAt === undefined ? undefined : Math.min(startAt, compactionThreshold(this.effectiveWindow));
  }

  /**
   * The most a reply may take (ADR-0070): the model's own output limit, held to
   * the room the window keeps above the compaction threshold, so a prompt the
   * guard let through and its reply still fit the window together.
   */
  get replyTokens(): number {
    return Math.min(this.options.model.maxOutputTokens, this.effectiveWindow - compactionThreshold(this.effectiveWindow));
  }

  /** The window in force is the assumed one: no setting, catalog or listing stated it and no overflow has measured it. */
  get windowAssumed(): boolean {
    return this.options.model.contextWindowSource === 'assumed' && this.effectiveWindow === this.options.model.contextWindow;
  }

  /** Compacts when the next prompt passes the threshold; the transcript as it now stands either way. */
  async beforeRequest(transcript: LoadedTranscript, step: number, signal: AbortSignal): Promise<LoadedTranscript> {
    const fixed = this.fixedTokens(transcript);
    const estimated = estimatePromptTokens(transcript, fixed);
    if (!shouldCompact(estimated, this.effectiveWindow, this.options.startAt) || transcript.messages.length < this.retryAt) return transcript;
    try {
      const compacted = await this.compact(transcript, step, signal, { fraction: undefined, preTokens: estimated });
      if (compacted) return compacted;
    } catch (err) {
      // A cancelled turn is the turn's to end; any other failure leaves the request as it was, and
      // an overflow then takes the shrink-and-retry path rather than the step being lost here.
      if (signal.aborted) throw err;
    }
    this.retryAt = transcript.messages.length + RETRY_AFTER_MESSAGES;
    return transcript;
  }

  /**
   * The provider refused the request as too long: compact so the whole prompt
   * fits within `fraction` of the window. Undefined when that changes nothing,
   * so the caller tries a smaller fraction.
   */
  shrink(transcript: LoadedTranscript, step: number, signal: AbortSignal, fraction: number): Promise<LoadedTranscript | undefined> {
    // A fraction is of the model's window; one no smaller than the window an
    // earlier overflow left in force would retry a size already refused.
    if (Math.floor(this.options.model.contextWindow * fraction) >= this.effectiveWindow && this.effectiveWindow < this.options.model.contextWindow) {
      return Promise.resolve(undefined);
    }
    const fixed = this.fixedTokens(transcript);
    return this.compact(transcript, step, signal, { fraction, preTokens: estimatePromptTokens(transcript, fixed) });
  }

  private fixedTokens(transcript: Readonly<LoadedTranscript>): number {
    return estimateFixedTokens(transcript.system ?? this.options.fallbackSystem, this.options.tools);
  }

  private async compact(
    transcript: LoadedTranscript,
    step: number,
    signal: AbortSignal,
    plan: { fraction: number | undefined; preTokens: number },
  ): Promise<LoadedTranscript | undefined> {
    const { model, client, store } = this.options;
    const window = plan.fraction === undefined ? this.effectiveWindow : model.contextWindow;
    const fixed = this.fixedTokens(transcript);
    const headTokens = transcript.messages.length > 0 && transcript.messages[0]?.role === 'user' ? estimateMessageTokens(transcript.messages[0]) : 0;
    const summaryAllowance = Math.min(SUMMARY_MAX_OUTPUT_TOKENS, model.maxOutputTokens, Math.floor(window * 0.1));
    // A retry's tail shrinks with its fraction, so each step down leaves less than the one before;
    // a start set below the guard shrinks it in proportion, so what is kept fits well under that start.
    const tailBudget = plan.fraction === undefined
      ? Math.floor(window * TAIL_FRACTION * Math.min(1, (this.options.startAt ?? Infinity) / compactionThreshold(window)))
      : Math.max(0, Math.min(Math.floor(window * TAIL_FRACTION * plan.fraction), Math.floor(window * plan.fraction) - fixed - headTokens - summaryAllowance));
    const split = splitForCompaction(transcript.messages, tailBudget, { allowEmptyTail: plan.fraction !== undefined });
    if (!split) return undefined;

    const middle = transcript.messages.slice(split.head, split.tailFrom);
    // Summarizing only the last summary again would spend a call to say the same thing shorter.
    if (middle.length === 1 && isSummaryMessage(middle[0])) return undefined;
    const tail = transcript.messages.slice(split.tailFrom);
    // The call that writes the summary has the same window, less its own prompt and reply.
    const inputTokens = Math.floor(window * (plan.fraction ?? 0.8)) - estimateTokens(SUMMARY_SYSTEM.length) - SUMMARY_MAX_OUTPUT_TOKENS;
    const { summary, usage } = await summarize(client, model, middle, { maxInputChars: Math.max(2_000, inputTokens * CHARS_PER_TOKEN), signal });

    const message = summaryMessage(summary);
    const postTokens = fixed + headTokens + estimateMessageTokens(message) + sumTokens(tail);
    // A summary that is not smaller than what it replaces would only add a call to every compaction.
    if (postTokens >= plan.preTokens && plan.fraction === undefined) {
      this.retryAt = transcript.messages.length + RETRY_AFTER_MESSAGES;
      return undefined;
    }
    await this.options.record({
      v: 1,
      kind: 'compaction',
      at: new Date().toISOString(),
      step,
      head: split.head,
      tailFrom: split.tailFrom,
      message,
      preTokens: plan.preTokens,
      postTokens,
      ...(usage ? { usage } : {}),
    });
    if (plan.fraction !== undefined) this.effectiveWindow = Math.floor(window * plan.fraction);
    this.announce(step, plan.preTokens, postTokens, usage);
    return store.load();
  }

  /**
   * The task log's compaction line, the meter's reset to the new size, and
   * the summary call's own spend. A step compacted again before its request
   * went through (a second refusal) is one compaction to the task: the line
   * is what reminds it of its brief and what running long counts, so only the
   * meter and the spend follow the later ones.
   */
  private announce(step: number, preTokens: number, postTokens: number, usage: ModelUsage | undefined): void {
    const { model, emit } = this.options;
    if (this.announcedStep !== step) emit({ type: 'compaction', trigger: 'auto', preTokens, postTokens });
    this.announcedStep = step;
    if (usage) emit({ type: 'usage', record: compactionUsageRecord(model, usage) });
    const reset: UsageRecord = { source: 'ordewell', model: model.id, compacted: true, contextTokens: postTokens, contextWindow: this.effectiveWindow, ...(this.windowAssumed ? { contextWindowAssumed: true } : {}) };
    emit({ type: 'usage', record: reset });
  }
}

/** The summary call's spend: billed, but an aggregate so it moves no context meter (`purpose`). */
function compactionUsageRecord(model: ModelInfo, usage: ModelUsage): UsageRecord {
  return {
    source: 'ordewell',
    model: model.id,
    aggregate: true,
    purpose: 'compaction',
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
    ...(usage.cost ? { reportedCost: { amount: usage.cost.amount, currency: usage.cost.currency, kind: 'billed' as const } } : {}),
  };
}
