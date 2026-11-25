import type { ResearchStep, ResearchStepOutcome, SkillLoadNotice } from '../models/Task';
import type { UsageLine } from '../models/Usage';
import type { RunnerSignIn } from '../services/signInHint';
import type { CompactionBlock, MessageBlock, MessageRole, PlanMarkerStatus, SkillLoadBlock, SubagentBlock, ToolBlock, ToolStatus, UsageBlock } from './blocks';
import { diffStat, outputLines, toolHeadline } from './format';
import { isFileEditTool } from '../services/harness/agentTools';
import { ranSealed, withoutSealedMark } from '../services/researchStepSummary';

/*
 * How the session's records — messages, research steps, subagents, transcript
 * markers, usage totals — read as blocks. Shared by the live view and the
 * reload, so the two cannot disagree about what a record shows.
 */

/** A line that is done: nothing streams into it any more. */
export function settledMessage(id: string, role: MessageRole, text: string, turnId?: string): MessageBlock {
  return { type: 'message', id, role, text, streaming: false, ...(turnId ? { turnId } : {}) };
}

/**
 * A planner reply's failure that is its runner signed out (ADR-0052): drawn as
 * an error, with that agent's ways in, where the reply would have stood.
 */
export function signedOutFailure(id: string, text: string, signIn: RunnerSignIn, turnId?: string): MessageBlock {
  return { ...settledMessage(id, 'error', text, turnId), signIn };
}

/** The user's message, marked with the skills it loaded when it loaded any, and when it was force sent. */
export function userMessage(id: string, text: string, skills: readonly SkillLoadNotice[], { turnId, forced }: { turnId?: string; forced?: boolean } = {}): MessageBlock {
  const block = settledMessage(id, 'user', text, turnId);
  return {
    ...block,
    ...(skills.length > 0 ? { skills: skills.map((s) => s.name) } : {}),
    ...(forced ? { forced: true } : {}),
  };
}

/** What a surface is told of a load: everything but the body, which only the planner is sent. */
export function skillLoadNotice({ invokedBy, name, source, path, attaches }: SkillLoadNotice): SkillLoadNotice {
  return { invokedBy, name, source, path, ...(attaches ? { attaches } : {}) };
}

/** `load_skill` as each harness names it: bare, `mcp__ordewell__load_skill`, `ordewell_load_skill`. */
const LOAD_SKILL_TOOL = /(?:^|_)load_skill$/;

/**
 * A research step as a surface is sent it. A `load_skill` result is a skill's
 * body, which only the planner is sent; the session keeps it in the skill-load
 * entry, so the step need only say which skill loaded.
 */
export function surfaceStep(step: ResearchStep): ResearchStep {
  if (!step.success || !LOAD_SKILL_TOOL.test(step.toolLabel ?? step.tool)) return step;
  const name = loadedSkillName(step.args);
  return { ...step, result: name ? `Loaded skill ${name}.` : 'Loaded a skill.' };
}

function loadedSkillName(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    const name = typeof parsed === 'object' && parsed !== null && 'name' in parsed ? parsed.name : undefined;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

export function skillLoadBlock(id: string, { invokedBy, name, source, path, attaches }: SkillLoadNotice, turnId?: string): SkillLoadBlock {
  return { type: 'skill_load', id, invokedBy, name, source, path, ...(attaches ? { attaches } : {}), ...(turnId ? { turnId } : {}) };
}

type SubagentFields = Omit<SubagentBlock, 'type' | 'id' | 'toolCallId' | 'model' | 'usage' | 'turnId'>
  & { toolCallId?: string; model?: string; usage?: SubagentBlock['usage']; turnId?: string };

export function subagentBlock(id: string, { toolCallId, model, usage, turnId, ...fields }: SubagentFields): SubagentBlock {
  return {
    type: 'subagent', id, ...fields,
    ...(toolCallId ? { toolCallId } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/** A planner compaction's block, with only the fields it has: what was not reported stays absent. */
export function compactionBlock(id: string, { trigger, compactionId, origin, status, summary, preTokens, postTokens, turnId }: Omit<CompactionBlock, 'type' | 'id'>): CompactionBlock {
  return {
    type: 'compaction', id, trigger,
    ...(compactionId ? { compactionId } : {}),
    ...(origin ? { origin } : {}),
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(postTokens !== undefined ? { postTokens } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export function usageBlock(id: string, { totals, bySubagent, byModel, model, contextFill }: UsageLine): UsageBlock {
  return { type: 'usage', id, totals, ...(byModel ? { byModel } : {}), ...(model ? { model } : {}), ...(bySubagent ? { bySubagent } : {}), ...(contextFill ? { contextFill } : {}) };
}

const STATUS_OF_OUTCOME: Record<ResearchStepOutcome, ToolStatus> = {
  success: 'ok',
  failure: 'error',
  refused: 'denied',
  denied: 'denied',
  not_executed: 'interrupted',
};

export function finishedTool(call: ToolBlock, output: string, outcome: ResearchStepOutcome): ToolBlock {
  const diff = outcome === 'success' && isFileEditTool(call.toolLabel ?? call.tool) ? diffStat(output) : null;
  // The model reads that a command ran sealed from its first line (ADR-0036 S4); a surface marks the row instead.
  const sealed = call.tool === 'bash' && ranSealed(output);
  const shown = sealed ? withoutSealedMark(output) : output;
  return { ...call, status: STATUS_OF_OUTCOME[outcome], outcome, output: shown, outputLineCount: outputLines(shown).length, ...(diff ? { diff } : {}), ...(sealed ? { sealed } : {}) };
}

export function settledTool(call: ToolBlock, step: ResearchStep): ToolBlock {
  return finishedTool(call, step.result, step.outcome);
}

export interface AnnouncedCall {
  tool: string;
  toolLabel?: string;
  args: string;
  toolCallId?: string;
  turnId?: string;
}

export function pendingTool(id: string, { tool, toolLabel, args, toolCallId, turnId }: AnnouncedCall): ToolBlock {
  return {
    type: 'tool', id, tool, headline: toolHeadline(tool, args, toolLabel), args, status: 'pending', output: '', outputLineCount: 0,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLabel ? { toolLabel } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

/** The row of a call known only from its result — a reload, or a result whose call was never announced. */
export function toolFromStep(id: string, step: ResearchStep, turnId?: string): ToolBlock {
  return settledTool(pendingTool(id, { ...step, turnId }), step);
}

/**
 * What a plan marker says, read from the transcript entry `PlannerConversation`
 * writes for it ("Plan generated with 2 tasks.", "Plan updated — now 1 task.").
 * That entry is the only record of the marker a reload has, so the live view
 * reads the same text rather than counting tasks itself.
 */
export function planMarker(content: string): { status: Exclude<PlanMarkerStatus, 'building'>; taskCount?: number } {
  const count = /(\d+) tasks?\b/.exec(content);
  return { status: content.startsWith('Plan updated') ? 'updated' : 'generated', ...(count ? { taskCount: Number(count[1]) } : {}) };
}
