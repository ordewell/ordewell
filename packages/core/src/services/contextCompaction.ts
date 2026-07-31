import { RESEARCH_TOOLS, SPAWN_RESEARCH_AGENT } from './researchTools';
import type { ResearchChat, ResearchTurn } from './BaseAiService';

/**
 * Research-context compaction (Option 1 for the truncated-plan bug): a long
 * research phase — especially with parallel subagents — can bloat the planner
 * context enough that the final plan-JSON emission runs out of output tokens
 * mid-object. The fix is on the input side: raw tool transcripts are pruned
 * to stubs while subagent digests are preserved — a digest is already the
 * compressed form of a whole research thread; the raw outputs are what it
 * summarized.
 */

export const COMPACTION_LIMITS = {
  /** Pruned outputs keep this much leading text so the model still sees what was there. */
  keepHeadChars: 400,
  /** Outputs at or below this size are never pruned — the savings would not pay for the loss. */
  minPrunableChars: 1500,
  /** Aggregate research-findings budget for the one-shot fallback plan prompt. */
  researchResultsMaxChars: 60_000,
  /**
   * Prompt-token level at which history is compacted proactively, before an
   * emission ever truncates: ~80% of a 128k context, the smallest window in
   * common planner use. Bigger-window models just compact earlier — that only
   * stubs bulky raw transcripts (digests are kept), a mild loss taken for
   * predictability.
   */
  proactivePromptTokens: 100_000,
};

/** Structural subset of an OpenAI-style chat message that compaction reads and rewrites. */
export interface CompactableMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
}

/**
 * Prune bulky raw tool outputs from a chat history in place so a follow-up
 * plan emission gets its context back. Subagent digests are kept whole.
 * Returns the number of characters removed.
 */
export function compactToolMessages(
  messages: CompactableMessage[],
  preserveToolNames: ReadonlySet<string> = new Set([SPAWN_RESEARCH_AGENT]),
): number {
  const nameById = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.id && tc.function?.name) nameById.set(tc.id, tc.function.name);
    }
  }

  let removed = 0;
  for (const m of messages) {
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const name = m.tool_call_id ? nameById.get(m.tool_call_id) : undefined;
    if (name && preserveToolNames.has(name)) continue;
    if (m.content.length <= COMPACTION_LIMITS.minPrunableChars) continue;
    const stub = m.content.slice(0, COMPACTION_LIMITS.keepHeadChars)
      + `\n[... ${name ?? 'tool'} output pruned (${m.content.length} chars) to free context for the plan — re-run the tool if needed]`;
    removed += m.content.length - stub.length;
    m.content = stub;
  }
  return removed;
}

/**
 * Wrap a chat so that any turn reporting prompt tokens past the threshold
 * compacts the history immediately — the next call (tool round or the plan
 * emission itself) then runs against a pruned context instead of a saturated
 * one. Opencode-style auto-compact, but deterministic: no summarizer model.
 * Reactive truncation repair stays as the backstop for whatever this misses.
 */
export function withProactiveCompaction(chat: ResearchChat): ResearchChat {
  const check = (turn: ResearchTurn): ResearchTurn => {
    if ((turn.promptTokens ?? 0) >= COMPACTION_LIMITS.proactivePromptTokens) chat.compactHistory?.();
    return turn;
  };
  return {
    sendMessage: (text, signal) => chat.sendMessage(text, signal).then(check),
    sendToolResults: (results, signal) => chat.sendToolResults(results, signal).then(check),
    compactHistory: chat.compactHistory?.bind(chat),
  };
}

interface ResultsBlock {
  tool: string | null;
  lines: string[];
}

const PRESERVED_BLOCKS = new Set([SPAWN_RESEARCH_AGENT, 'llm_response']);

/**
 * Bound the accumulated research-findings text embedded in the one-shot
 * fallback plan prompt. Blocks are pruned oldest-first: raw tool transcripts
 * before subagent digests and the model's own closing synthesis, which only
 * shrink if the budget still cannot be met without them.
 */
export function compactResearchResults(
  resultsText: string,
  maxChars = COMPACTION_LIMITS.researchResultsMaxChars,
): string {
  if (resultsText.length <= maxChars) return resultsText;

  // Blocks are delimited by the headers executeToolCalls writes:
  // "[toolName({...args})]" or "[LLM response]", always at line start.
  const knownNames = new Set(RESEARCH_TOOLS.map((t) => t.name)).add(SPAWN_RESEARCH_AGENT);
  const headerRe = /^\[([a-z_]+)\(/;
  const blocks: ResultsBlock[] = [{ tool: null, lines: [] }];
  for (const line of resultsText.split('\n')) {
    const m = headerRe.exec(line);
    const tool = m && knownNames.has(m[1]) ? m[1] : line === '[LLM response]' ? 'llm_response' : null;
    if (tool) blocks.push({ tool, lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }

  // Splitting the line list into blocks and re-joining is the identity, so
  // untouched blocks survive byte-for-byte.
  const texts = blocks.map((b) => b.lines.join('\n'));
  let total = texts.reduce((n, t) => n + t.length, 0);
  const prunePasses: Array<(b: ResultsBlock) => boolean> = [
    (b) => b.tool !== null && !PRESERVED_BLOCKS.has(b.tool),
    (b) => b.tool !== null && PRESERVED_BLOCKS.has(b.tool),
  ];
  for (const shouldPrune of prunePasses) {
    for (const [i, b] of blocks.entries()) {
      if (total <= maxChars) break;
      if (!shouldPrune(b) || texts[i].length <= COMPACTION_LIMITS.minPrunableChars) continue;
      const stub = texts[i].slice(0, COMPACTION_LIMITS.keepHeadChars)
        + `\n[... pruned ${texts[i].length} chars to fit the research budget]`;
      total -= texts[i].length - stub.length;
      texts[i] = stub;
    }
  }

  // Blocks partition the split lines, so joining block texts with '\n' undoes
  // the split exactly — except the synthetic empty first block, which must not
  // inject a leading newline when the text opened with a header line.
  return (blocks[0].lines.length === 0 ? texts.slice(1) : texts).join('\n');
}
