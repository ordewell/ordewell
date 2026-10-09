import type { ResearchStep, ResearchStepOutcome, SkillLoadNotice } from '../models/Task';
import type { UsageLine } from '../models/Usage';
import type { MessageBlock, MessageRole, PlanMarkerStatus, SkillLoadBlock, SubagentBlock, ToolBlock, ToolStatus, UsageBlock } from './blocks';
import { diffStat, outputLines, toolHeadline } from './format';
import { isFileEditTool } from '../services/harness/agentTools';

/*
 * How the session's records — messages, research steps, subagents, transcript
 * markers, usage totals — read as blocks. Shared by the live view and the
 * reload, so the two cannot disagree about what a record shows.
 */

/** A line that is done: nothing streams into it any more. */
export function settledMessage(id: string, role: MessageRole, text: string, turnId?: string): MessageBlock {
  return { type: 'message', id, role, text, streaming: false, ...(turnId ? { turnId } : {}) };
}

/** The user's message, marked with the skills it loaded when it loaded any. */
export function userMessage(id: string, text: string, skills: readonly SkillLoadNotice[], turnId?: string): MessageBlock {
  const block = settledMessage(id, 'user', text, turnId);
  return skills.length > 0 ? { ...block, skills: skills.map((s) => s.name) } : block;
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

export function usageBlock(id: string, { totals, bySubagent, contextFill }: UsageLine): UsageBlock {
  return { type: 'usage', id, totals, ...(bySubagent ? { bySubagent } : {}), ...(contextFill ? { contextFill } : {}) };
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
  return { ...call, status: STATUS_OF_OUTCOME[outcome], outcome, output, outputLineCount: outputLines(output).length, ...(diff ? { diff } : {}) };
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
