import { v4 as uuidv4 } from 'uuid';
import { CONFINED_RESEARCH_TOOLS, runResearchAgent, SUBAGENT_LIMITS } from '../ResearchSubagents';
import { addUsage, type UsageRecord, type UsageTotals } from '../../models/Usage';
import type { ResearchChat } from '../BaseAiService';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import type { McpToolContext, McpToolReply, PlannerToolHandler, SpawnResearchAgentArgs } from '../mcp';

/**
 * Ordewell's research agent for a harness planner that has no agents of its
 * own (ADR-0066), served as the MCP tool `spawn_research_agent`. Each call is
 * one stateless agent from {@link runResearchAgent}, on an API provider's
 * subagent chat, confined to {@link CONFINED_RESEARCH_TOOLS}: it reads the
 * workspace and nothing else. No shell, sealed or not, no web, no spawn, and
 * nothing in it can ask anyone, so it widens the planner's envelope by no
 * capability the planner's own read tools lack.
 *
 * Its progress goes to the open turn's sink, which files its steps and its
 * usage under its subagent id as a harness subagent's are; a call while no
 * turn is open is refused, since nothing it found could reach anyone.
 */
export interface HarnessResearchAgentDeps {
  /** An API provider's confined subagent chat, or null where it has none (Gemini). */
  createChat: (onReasoning: (delta: string) => void, onUsage: (record: UsageRecord) => void, only: ReadonlySet<string>) => ResearchChat | null;
  /** The planner's workspace filesystem; the agent's reads are confined to its root. */
  fs: IFileSystem;
  /** The subagent model, shown with its lifecycle events. */
  model?: string;
  /** The open turn's progress sink, or undefined when no turn is open. */
  turnSink: () => ((progress: ResearchProgress) => void) | undefined;
  /** Agents running at once across the planner's calls; later calls wait for a slot. */
  maxConcurrent?: number;
  newId?: () => string;
}

/** A counting semaphore: MCP calls arrive one by one, so the bound is held across them, not per batch. */
function semaphore(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(signal: AbortSignal, run: () => Promise<T>, onAbort: () => T): Promise<T> => {
    if (running >= limit) {
      await new Promise<void>((resolve) => {
        const go = () => { signal.removeEventListener('abort', cancel); resolve(); };
        const cancel = () => { const at = waiting.indexOf(go); if (at >= 0) waiting.splice(at, 1); resolve(); };
        waiting.push(go);
        signal.addEventListener('abort', cancel, { once: true });
      });
      if (signal.aborted) return onAbort();
    }
    running++;
    try { return await run(); } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export const NO_TURN_OPEN = 'spawn_research_agent runs only inside your turn: no turn is open, so nothing it found could reach anyone.';

export function harnessResearchAgent(deps: HarnessResearchAgentDeps): (args: SpawnResearchAgentArgs, context: McpToolContext) => Promise<McpToolReply> {
  const slot = semaphore(deps.maxConcurrent ?? SUBAGENT_LIMITS.maxConcurrent);
  const newId = deps.newId ?? uuidv4;
  return async ({ prompt }, { signal }) => {
    if (!deps.turnSink()) return { text: NO_TURN_OPEN, isError: true };
    return slot(signal, async () => {
      // Read again once a slot is free: the turn may have ended while this call waited.
      const sink = deps.turnSink();
      if (!sink) return { text: NO_TURN_OPEN, isError: true };
      let usage: UsageTotals | undefined;
      const outcome = await runResearchAgent(prompt.trim(), {
        createChat: (onReasoning, onUsage) => {
          const chat = deps.createChat(onReasoning, onUsage, CONFINED_RESEARCH_TOOLS);
          if (!chat) throw new Error('research agents are not available for the configured API provider');
          return chat;
        },
        fs: deps.fs,
        signal,
        subagentId: newId(),
        model: deps.model,
        tools: CONFINED_RESEARCH_TOOLS,
        usage: () => usage,
        onProgress: (progress) => {
          if (progress.type === 'usage' && progress.record) usage = addUsage(usage ?? {}, progress.record);
          // The turn the call started in, or none: a step after it ended reaches nobody's log.
          deps.turnSink()?.(progress);
        },
      });
      return outcome.success ? { text: outcome.output } : { text: outcome.output, isError: true };
    }, () => ({ text: '[research agent stopped before it started]', isError: true }));
  };
}

/**
 * The planner's handler with the research agent added, every other tool as
 * it was: the handler's own methods stay on its prototype chain.
 */
export function withResearchAgent(handler: PlannerToolHandler, run: NonNullable<PlannerToolHandler['spawnResearchAgent']>): PlannerToolHandler {
  return Object.assign(Object.create(handler) as PlannerToolHandler, { spawnResearchAgent: run });
}
