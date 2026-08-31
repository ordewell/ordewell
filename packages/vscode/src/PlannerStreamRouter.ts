import type { ResearchProgress, SessionMessage } from '@ordewell/core';

/** The slice of the webview bridge the planner stream renders through. */
export interface PlannerStreamSink {
  streamToken(token: string): void;
  sendResearchProgress(step: ResearchProgress): void;
}

/**
 * Routes the four streaming SessionMessage variants (plan_token,
 * plan_thinking, research_step, research_step_done) onto the webview
 * protocol. Session owns the ResearchProgress → SessionMessage translation
 * behind its broadcast seam; this is the VS Code adapter's half — the only
 * place SessionMessage becomes webview messages.
 *
 * Returns true when the message was a streaming variant (whether or not it
 * was delivered), so the caller can fall through to lifecycle handling for
 * everything else. `active` gates delivery: streaming variants arriving
 * after the planner turn was stopped are dropped, never rendered late.
 */
export function routePlannerStream(msg: SessionMessage, sink: PlannerStreamSink, active: boolean): boolean {
  switch (msg.type) {
    case 'plan_token':
      if (active) sink.streamToken(msg.token);
      return true;
    case 'plan_thinking':
      if (active) sink.sendResearchProgress({ type: 'thinking', text: msg.text });
      return true;
    case 'planner_liveness':
      // No content to render — routed purely so the webview's watchdog sees
      // the postMessage traffic and doesn't mistake filtered subagent output
      // for a stalled planner.
      if (active) sink.sendResearchProgress({ type: 'liveness' });
      return true;
    case 'research_step':
      if (active) sink.sendResearchProgress({ type: 'tool_call', tool: msg.tool, toolLabel: msg.toolLabel, toolArgs: msg.args, subagentId: msg.subagentId, toolCallId: msg.toolCallId });
      return true;
    case 'research_step_done':
      if (active) sink.sendResearchProgress({ type: 'tool_result', step: msg.step, subagentId: msg.subagentId, toolCallId: msg.step.toolCallId });
      return true;
    default:
      return false;
  }
}
