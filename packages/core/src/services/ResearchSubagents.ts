import { executeTool } from './executeTool';
import { subagentToolSpecs } from './researchTools';
import { classifyCommand, pathLikeArgs } from './commandPolicy';
import { resolveResearchShell } from './researchShell';
import { resolveWithin } from './pathScope';
import { classifyOutcome } from './researchStepSummary';
import type { IFileSystem, ToolOutcome } from '../interfaces/IFileSystem';
import type { ResearchChat, ToolResult } from './BaseAiService';
import type { ResearchProgress, ResearchStep } from '../models/Task';

/**
 * Read-only research subagents (issue #34), opencode-style: one stateless
 * subagent per spawn_research_agent tool call, so the planner can follow
 * threads as they emerge; parallelism comes from the planner batching several
 * spawn calls in one message (the service layer runs them concurrently).
 * This module owns one subagent's mini research loop — it never imports
 * BaseAiService/OpenAiService (the chat factory comes in as a dependency), so
 * the service → executeTool import chain stays acyclic.
 */

export const SUBAGENT_LIMITS = {
  /** Max spawn calls in flight at once; extra calls in the same turn wait for a slot. */
  maxConcurrent: 3,
  maxSteps: 10,
  digestMaxChars: 6000,
  toolOutputMaxChars: 20000,
};

export interface SubagentDeps {
  /**
   * Builds a fresh chat (own history, subagent system prompt, cheap model).
   * Receives a reasoning-delta callback to wire into the chat, so a
   * reasoning-capable subagent model streams its own live thinking too.
   */
  createChat: (onReasoning: (delta: string) => void) => ResearchChat;
  fs: IFileSystem;
  signal?: AbortSignal;
  /** Structured thinking/tool_call/tool_result events for the UI while the subagent works (caller tags with subagentId). */
  onProgress?: (progress: ResearchProgress) => void;
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
    bash: async (command) => {
      // Same dialect the wrapped filesystem will execute under — a subagent
      // must not classify under different rules than the parent.
      const dialect = resolveResearchShell().dialect;
      const { tier, reason } = classifyCommand(command, { dialect });
      if (tier !== 'auto') {
        return refused(
          tier === 'refuse'
            ? `Command refused: ${reason}`
            : `"${command}" needs user approval, and research agents run in the background where nothing can be approved. Use the read-only research tools, and note in your digest that this command would answer the question.`,
        );
      }
      // An `auto` binary (cat, find, rg, …) is only auto because reading is
      // read-only — its arguments can still name a path outside the
      // workspace, and a subagent can never prompt to approve one.
      const escaping = pathLikeArgs(command, { dialect }).find((p) => !withinWorkspace(p));
      if (escaping) return outsideRefusal(escaping);
      return fs.bash(command);
    },
  };
}

async function runLoop(prompt: string, deps: SubagentDeps): Promise<string> {
  if (deps.signal?.aborted) return '[research agent aborted before starting]';
  const fs = nonPromptingFs(deps.fs);
  const chat = deps.createChat((delta) => deps.onProgress?.({ type: 'thinking', text: delta }));
  let turn = await chat.sendMessage(prompt, deps.signal);

  for (let step = 0; turn.hasToolCalls && step < SUBAGENT_LIMITS.maxSteps; step++) {
    if (deps.signal?.aborted) return `[research agent aborted] Partial findings:\n${turn.text}`;
    const results: ToolResult[] = [];
    for (const tc of turn.toolCalls) {
      // Anything outside the read-only allowlist (fetch, recursive spawn,
      // hallucinated write tools) is refused with a synthetic result — never
      // dispatched — so the API history stays valid and nothing executes.
      if (!ALLOWED_TOOL_NAMES.has(tc.name)) {
        const refusal = `Tool "${tc.name}" is not available. You are a read-only research subagent: your only tools are ${[...ALLOWED_TOOL_NAMES].join(', ')}. You cannot fetch URLs, spawn further agents, or modify files. If a specific URL or resource would have answered your question, name it in your digest so the planner can fetch it directly. Otherwise continue with the available tools, then reply with your digest.`;
        results.push({ name: tc.name, output: refusal, truncated: false, totalChars: refusal.length, id: tc.id });
        continue;
      }
      const args = { ...tc.args };
      if (tc.name === 'read_file' && !('maxBytes' in args) && !('limit' in args)) args.limit = 2000;
      const toolArgs = JSON.stringify(tc.args);
      deps.onProgress?.({ type: 'tool_call', tool: tc.name, toolArgs, toolCallId: tc.id });
      const res = await executeTool(tc.name, args, fs);
      const output = res.output.length > SUBAGENT_LIMITS.toolOutputMaxChars
        ? res.output.slice(0, SUBAGENT_LIMITS.toolOutputMaxChars) + `\n[... truncated to ${SUBAGENT_LIMITS.toolOutputMaxChars} chars, total ${res.output.length}]`
        : res.output;
      const stepEntry: ResearchStep = {
        id: `subrs-${Date.now()}-${step}`,
        tool: tc.name as ResearchStep['tool'],
        args: toolArgs,
        result: output,
        success: res.success,
        outcome: classifyOutcome(res.success, res.output),
        toolCallId: tc.id,
        timestamp: new Date().toISOString(),
      };
      deps.onProgress?.({ type: 'tool_result', toolResult: output, step: stepEntry, toolCallId: tc.id });
      results.push({ name: tc.name, output, truncated: res.truncated || output.length < res.output.length, totalChars: res.output.length, id: tc.id });
    }
    turn = await chat.sendToolResults(results, deps.signal);
  }

  // Step budget exhausted while the model still wants tools: answer the
  // pending calls synthetically (history stays valid, nothing executes) and
  // push for the digest — mirrors the parent loop's wrap-up rounds.
  if (turn.hasToolCalls && !deps.signal?.aborted) {
    const notice = `Research budget exhausted (${SUBAGENT_LIMITS.maxSteps} tool rounds) — this call was NOT executed and no further tool calls will be. Reply now with your digest of everything learned so far.`;
    turn = await chat.sendToolResults(
      turn.toolCalls.map((tc) => ({ name: tc.name, output: notice, truncated: false, totalChars: notice.length, id: tc.id })),
      deps.signal,
    );
  }

  const digest = turn.text;
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
  try {
    return { success: true, output: await runLoop(prompt, deps), truncated: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, output: `[research agent failed: ${reason}] Continue researching this area yourself with your own tools.`, truncated: false };
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
