import { executeTool } from './executeTool';
import { subagentToolSpecs } from './researchTools';
import { classifyCommand, pathRefs } from './commandPolicy';
import { resolveResearchShell, researchPolicyOptions } from './researchShell';
import { resolveWithin, resolveRef } from './pathScope';
import { classifyOutcome } from './researchStepSummary';
import type { IFileSystem, ToolOutcome } from '../interfaces/IFileSystem';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { ResearchChat, ToolResult } from './BaseAiService';
import type { ResearchProgress, ResearchStep } from '../models/Task';
import type { UsageRecord, UsageTotals } from '../models/Usage';

/**
 * Read-only research subagents (issue #34), opencode-style: one stateless
 * subagent per spawn_research_agent tool call, so the planner can follow
 * threads as they emerge; parallelism comes from the planner batching several
 * spawn calls in one message (the service layer runs them concurrently).
 * This module owns one subagent's mini research loop — it never imports
 * BaseAiService/OpenAiService (the chat factory comes in as a dependency), so
 * the service → executeTool import chain stays acyclic.
 */

/**
 * One budget for both research agents, the API-key one and OpenCode's login
 * one (ADR-0066). Sized from the g5-t67 re-run (3 DeepSeek + 3 GLM planners,
 * 27 agents): 19 ran out of their 16 steps, and each of those had made exactly
 * 16 rounds of reads (3-4 calls a round) with the next round still grepping;
 * the 8 that finished took 5-15 rounds, median 11. The 19 are cut off, so 24
 * is an estimate, not a measurement: it covers the finishers with room and
 * gives a cut-off agent half again its budget. The cap bound too: 20 of the 27
 * digests were truncated at the old 8,000 chars, 18 of them partials whose
 * closing "Uncertainties" section was what got cut, so it is 12,000. A run
 * that still runs out returns what it found, marked partial, naming the reads
 * it left (`partialDigest`).
 */
export const SUBAGENT_LIMITS = {
  /** Max spawn calls in flight at once; extra calls in the same turn wait for a slot. */
  maxConcurrent: 3,
  maxSteps: 24,
  digestMaxChars: 12000,
  toolOutputMaxChars: 20000,
};

/**
 * The tools a research agent served to a harness planner over MCP may call
 * (ADR-0066): the workspace reads alone. No shell, sealed or not, no web, and
 * no spawn, so the agent widens the planner's envelope by nothing but the
 * reads its own read tools already have.
 */
export const CONFINED_RESEARCH_TOOLS: ReadonlySet<string> = new Set(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir']);

export interface SubagentDeps {
  /**
   * Builds a fresh chat (own history, subagent system prompt, cheap model).
   * Receives the callbacks to wire into the chat: reasoning deltas, so a
   * reasoning-capable subagent model streams its own live thinking too, and
   * each call's usage, which this loop files under the subagent.
   */
  createChat: (onReasoning: (delta: string) => void, onUsage: (record: UsageRecord) => void) => ResearchChat;
  fs: IFileSystem;
  signal?: AbortSignal;
  /**
   * The fetcher the subagent's `fetch`/`web_search` calls go through, already
   * a non-prompting variant: a read that would ask is refused, with the gap to
   * report (ADR-0027). Absent means the web tools report themselves
   * unavailable.
   */
  fetcher?: IWebFetcher;
  /** This subagent's id, stamped on its progress events and its step ids so a replay can regroup them. */
  subagentId?: string;
  /** The model this subagent runs on, shown with its lifecycle events. */
  model?: string;
  /** This subagent's running usage, read when it finishes; absent means it reported none. */
  usage?: () => UsageTotals | undefined;
  /** Structured lifecycle/thinking/tool_call/tool_result events for the UI while the subagent works. */
  onProgress?: (progress: ResearchProgress) => void;
  /**
   * The tools this agent may call, which can only narrow the research set: a
   * call to any other is refused with a synthetic result, never dispatched.
   * Absent: every research tool.
   */
  tools?: ReadonlySet<string>;
}

export interface SubagentToolOutcome {
  success: boolean;
  output: string;
  truncated: boolean;
}

const ALLOWED_TOOL_NAMES = new Set(subagentToolSpecs().map((t) => t.name));

function refused(output: string): ToolOutcome {
  return { success: false, output, truncated: false };
}

/**
 * A subagent runs in the background with nobody watching it, so it must never
 * reach a code path that pauses for approval — a prompt attributed to no
 * visible action, or three prompts at once from three concurrent agents, is
 * worse than a refusal. This wrapper enforces that at the capability boundary
 * rather than trusting the agent's prompt: the auto-tier read-only commands
 * still work, and anything that would ask is refused with an actionable
 * message telling the agent to report the gap in its digest instead.
 *
 * Delegation is explicit rather than a spread — `fs` is a class instance, so
 * its methods live on the prototype and would not survive being copied.
 */
function nonPromptingFs(fs: IFileSystem): IFileSystem {
  const withinWorkspace = (p: string | undefined): boolean =>
    resolveWithin(fs.getWorkspaceRoot(), p ?? '.').inside;

  const outsideRefusal = (p: string) => refused(
    `Path "${p}" is outside the workspace. Research agents are confined to the workspace root — note the gap in your digest and let the planner request it directly.`,
  );

  return {
    getWorkspaceRoot: () => fs.getWorkspaceRoot(),
    readFile: (p, opts) => (withinWorkspace(p) ? fs.readFile(p, opts) : Promise.resolve(outsideRefusal(p))),
    readFiles: (paths) => {
      const escaping = paths.find((p) => !withinWorkspace(p));
      return escaping ? Promise.resolve(outsideRefusal(escaping)) : fs.readFiles(paths);
    },
    glob: (pattern, opts) => (withinWorkspace(opts?.path) ? fs.glob(pattern, opts) : Promise.resolve(outsideRefusal(opts!.path!))),
    grep: (pattern, opts) => (withinWorkspace(opts?.path) ? fs.grep(pattern, opts) : Promise.resolve(outsideRefusal(opts!.path!))),
    findSymbol: (symbol, opts) => (withinWorkspace(opts?.path) ? fs.findSymbol(symbol, opts) : Promise.resolve(outsideRefusal(opts!.path!))),
    listDir: (p, depth) => (withinWorkspace(p) ? fs.listDir(p, depth) : Promise.resolve(outsideRefusal(p))),
    bash: async (command, signal, opts) => {
      const shell = resolveResearchShell();
      const policy = researchPolicyOptions(shell);
      const { tier, reason } = classifyCommand(command, policy);
      // An `auto` binary (cat, find, rg, …) is only auto because reading is
      // read-only — its arguments can still name a path outside the
      // workspace, and a subagent can never prompt to approve one.
      // Named as resolved: after a `cd`, the path as written says nothing about where it points.
      const escaping = pathRefs(command, policy).map((ref) => resolveRef(fs.getWorkspaceRoot(), ref, shell.hostPath)).find((r) => !r.inside);
      // Only `auto` reaches the shell unsealed, so every command a subagent
      // runs runs without the network (ADR-0011 B3): nothing it could ask for
      // was approved.
      if (tier === 'auto' && !escaping && !opts?.sealed) return fs.bash(command, signal);
      // A sealed run asks nobody, so what would have asked or been refused
      // runs sealed where the host can seal it (ADR-0036 S5); an exclusion or
      // a denial still refuses it there.
      if (opts?.sealed || await fs.canSeal?.()) return fs.bash(command, signal, { sealed: true });
      if (tier === 'refuse') return refused(`Command refused: ${reason}`);
      if (tier === 'auto' && escaping) return outsideRefusal(escaping.abs);
      return refused(`"${command}" needs user approval, and research agents run in the background where nothing can be approved. Use the read-only research tools, and note in your digest that this command would answer the question.`);
    },
  };
}

function withoutContext({ contextTokens: _context, ...record }: UsageRecord): UsageRecord {
  return record;
}

/** What a research call asked for and never got, in a line the planner can hand to another agent. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return `${name} ${text.length > 200 ? `${text.slice(0, 200)}...` : text}`;
}

/**
 * A digest cut short by the step budget: the findings so far under a PARTIAL
 * header, then exactly what the cut-off step wanted to read. The unread list
 * is built from the calls, not from the model, and survives the cap, so the
 * planner can send another agent there instead of reading it itself.
 */
export function partialDigest(found: string, unread: string[], maxSteps = SUBAGENT_LIMITS.maxSteps): string {
  const header = `[PARTIAL: the ${maxSteps}-step budget ran out before this research was finished. Treat the findings below as incomplete.]`;
  const left = unread.length
    ? `Left unread:\n${unread.slice(0, 10).map((u) => `- ${u}`).join('\n')}${unread.length > 10 ? `\n- (+${unread.length - 10} more)` : ''}`
    : 'Left unread: whatever the next step would have read; the brief was not fully covered.';
  const marker = '\n[... findings truncated ...]\n';
  const room = Math.max(0, SUBAGENT_LIMITS.digestMaxChars - header.length - left.length - 4);
  const text = found.trim();
  // Keep the end: an agent closes with what it did not cover, which is what
  // the planner needs most from a partial digest.
  const head = Math.max(0, Math.floor((room - marker.length) * 0.6));
  const body = text.length > room ? `${text.slice(0, head)}${marker}${text.slice(text.length - Math.max(0, room - marker.length - head))}` : text;
  return `${header}\n\n${body}\n\n${left}`;
}

async function runLoop(prompt: string, deps: SubagentDeps): Promise<string> {
  if (deps.signal?.aborted) return '[research agent aborted before starting]';
  const fs = nonPromptingFs(deps.fs);
  const allowed = deps.tools ? new Set([...deps.tools].filter((name) => ALLOWED_TOOL_NAMES.has(name))) : ALLOWED_TOOL_NAMES;
  const chat = deps.createChat(
    (delta) => deps.onProgress?.({ type: 'thinking', text: delta, subagentId: deps.subagentId }),
    // The record says who made the call: unstamped, the ledger would read the
    // subagent's prompt as the planner's own and measure its context by it.
    // The chat states the context its call leaves; a subagent's is no meter's.
    (record) => deps.onProgress?.({ type: 'usage', record: deps.subagentId ? { ...withoutContext(record), subagentId: deps.subagentId } : record }),
  );
  let turn = await chat.sendMessage(prompt, deps.signal);

  for (let step = 0; turn.hasToolCalls && step < SUBAGENT_LIMITS.maxSteps; step++) {
    if (deps.signal?.aborted) return `[research agent aborted] Partial findings:\n${turn.text}`;
    const results: ToolResult[] = [];
    for (const tc of turn.toolCalls) {
      // Anything outside the read-only allowlist (recursive spawn, hallucinated
      // write tools) is refused with a synthetic result — never dispatched — so
      // the API history stays valid and nothing executes.
      if (!allowed.has(tc.name)) {
        const refusal = `Tool "${tc.name}" is not available. You are a read-only research subagent: your only tools are ${[...allowed].join(', ')}. You cannot spawn further agents or modify files. If a specific resource would have answered your question, name it in your digest so the planner can fetch it directly. Otherwise continue with the available tools, then reply with your digest.`;
        results.push({ name: tc.name, output: refusal, truncated: false, totalChars: refusal.length, id: tc.id });
        continue;
      }
      const args = { ...tc.args };
      if (tc.name === 'read_file' && !('maxBytes' in args) && !('limit' in args)) args.limit = 2000;
      const toolArgs = JSON.stringify(tc.args);
      deps.onProgress?.({ type: 'tool_call', tool: tc.name, toolArgs, toolCallId: tc.id, subagentId: deps.subagentId });
      // Signal-aware per call, not just per round: a subagent round routinely
      // carries several calls, and a stop that only lands between rounds still
      // waits out every one of them.
      const res = await executeTool(tc.name, args, fs, deps.fetcher, deps.signal);
      const output = res.output.length > SUBAGENT_LIMITS.toolOutputMaxChars
        ? res.output.slice(0, SUBAGENT_LIMITS.toolOutputMaxChars) + `\n[... truncated to ${SUBAGENT_LIMITS.toolOutputMaxChars} chars, total ${res.output.length}]`
        : res.output;
      const stepEntry: ResearchStep = {
        // The subagentId in the id: two concurrent subagents run the same
        // step numbers in the same millisecond, and an id collision would
        // make their persisted steps indistinguishable on reload.
        id: `subrs-${deps.subagentId ?? 'local'}-${Date.now()}-${step}`,
        tool: tc.name as ResearchStep['tool'],
        args: toolArgs,
        result: output,
        success: res.success,
        outcome: classifyOutcome(res.success, res.output),
        subagentId: deps.subagentId,
        toolCallId: tc.id,
        timestamp: new Date().toISOString(),
      };
      deps.onProgress?.({ type: 'tool_result', toolResult: output, step: stepEntry, toolCallId: tc.id, subagentId: deps.subagentId });
      results.push({ name: tc.name, output, truncated: res.truncated || output.length < res.output.length, totalChars: res.output.length, id: tc.id });
    }
    turn = await chat.sendToolResults(results, deps.signal);
  }

  // Step budget exhausted while the model still wants tools: answer the
  // pending calls synthetically (history stays valid, nothing executes) and
  // push for the digest — mirrors the parent loop's wrap-up rounds.
  let unread: string[] | undefined;
  if (turn.hasToolCalls && !deps.signal?.aborted) {
    unread = turn.toolCalls.map((tc) => describeCall(tc.name, tc.args));
    const notice = `Research budget exhausted (${SUBAGENT_LIMITS.maxSteps} tool rounds) — this call was NOT executed and no further tool calls will be. Reply now with your digest of everything learned so far, and end it with a "Not covered" section naming the files and areas you did not get to, so the planner can send another agent there.`;
    turn = await chat.sendToolResults(
      turn.toolCalls.map((tc) => ({ name: tc.name, output: notice, truncated: false, totalChars: notice.length, id: tc.id })),
      deps.signal,
    );
  }

  const digest = turn.text;
  if (unread) return partialDigest(digest, unread);
  return digest.length > SUBAGENT_LIMITS.digestMaxChars
    ? digest.slice(0, SUBAGENT_LIMITS.digestMaxChars) + `\n[... digest truncated to ${SUBAGENT_LIMITS.digestMaxChars} chars, total ${digest.length}]`
    : digest;
}

/**
 * Run one research agent to completion. Never throws: any failure becomes a
 * failed tool result telling the planner to continue sequentially — a subagent
 * can never fail a plan or a turn.
 */
export async function runResearchAgent(prompt: string, deps: SubagentDeps): Promise<SubagentToolOutcome> {
  deps.onProgress?.({ type: 'subagent_started', subagentId: deps.subagentId, brief: prompt, model: deps.model });
  try {
    const digest = await runLoop(prompt, deps);
    // runLoop returns a partial digest rather than throwing when stopped, so
    // the stop is read off the signal — an aborted run is 'stopped', not 'done'.
    const stopped = deps.signal?.aborted ?? false;
    deps.onProgress?.({ type: 'subagent_finished', subagentId: deps.subagentId, outcome: stopped ? 'stopped' : 'done', digest, usage: deps.usage?.() });
    return { success: !stopped, output: digest, truncated: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const output = `[research agent failed: ${reason}] Continue researching this area yourself with your own tools.`;
    deps.onProgress?.({ type: 'subagent_finished', subagentId: deps.subagentId, outcome: 'failed', digest: output, usage: deps.usage?.() });
    return { success: false, output, truncated: false };
  }
}

/**
 * Bounded-concurrency helper for a turn that carries several spawn calls:
 * chunks of maxConcurrent run in parallel, later chunks wait — nothing is
 * refused. Results come back in input order.
 */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let start = 0; start < items.length; start += limit) {
    const chunk = items.slice(start, start + limit);
    await Promise.all(chunk.map(async (item, offset) => {
      results[start + offset] = await fn(item, start + offset);
    }));
  }
  return results;
}

/**
 * One read a research agent outside this loop asked for (ADR-0066): the
 * OpenCode 2.x agent on the user's login, served over a research token.
 * The same confinement and the same limits as {@link runResearchAgent}'s own
 * calls: only {@link CONFINED_RESEARCH_TOOLS}, every path inside the
 * workspace root, nothing that could ask anyone, read_file capped at 2000
 * lines unless asked otherwise, and output cut to the subagent's limit.
 */
export async function confinedRead(name: string, args: Record<string, unknown>, fs: IFileSystem, signal?: AbortSignal): Promise<ToolOutcome> {
  if (!CONFINED_RESEARCH_TOOLS.has(name)) return refused(`${name} is not available. You are a read-only research subagent: only ${[...CONFINED_RESEARCH_TOOLS].join(', ')}.`);
  const call = { ...args };
  if (name === 'read_file' && !('maxBytes' in call) && !('limit' in call)) call.limit = 2000;
  const res = await executeTool(name, call, nonPromptingFs(fs), undefined, signal);
  const max = SUBAGENT_LIMITS.toolOutputMaxChars;
  return res.output.length > max
    ? { ...res, output: res.output.slice(0, max) + `\n[... truncated to ${max} chars, total ${res.output.length}]`, truncated: true }
    : res;
}
