import { summarizeToolCall } from '@ordewell/core/plan-utils';
import type { ResearchStep, ResearchStepOutcome } from '@ordewell/core';
import type { WsEvent } from '../apiClient';

/**
 * Renders the planner's research stream as terminal lines. Pure, so the
 * headless log — the only audit trail a piped or CI run leaves behind — is
 * testable without a daemon or a socket.
 */

const OUTCOME_MARK: Record<ResearchStepOutcome, string> = {
  success: '✓',
  failure: '✗',
  refused: '⊘',
  denied: '⊘',
  not_executed: '–',
};

const RESULT_CHARS = 160;
const VERBOSE_RESULT_CHARS = 600;
const THINKING_CHARS = 300;

export interface StepLineOptions {
  /** `--verbose`: include the planner's raw reasoning and longer result previews. */
  verbose?: boolean;
}

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** The line a stream event should print, or null when it prints nothing. */
export function formatStepLine(event: WsEvent, options: StepLineOptions = {}): string | null {
  if (event.type === 'research_step') {
    const summary = summarizeToolCall(String(event.tool), String(event.args || '{}'), event.toolLabel as string | undefined);
    return event.subagentId ? `  ↳ ${summary}` : summary;
  }

  if (event.type === 'research_step_done') {
    const step = event.step as ResearchStep | undefined;
    if (!step) return null;
    const mark = OUTCOME_MARK[step.outcome] ?? '✓';
    const summary = summarizeToolCall(step.tool, step.args, step.toolLabel);
    const result = oneLine(step.result ?? '', options.verbose ? VERBOSE_RESULT_CHARS : RESULT_CHARS);
    const indent = event.subagentId ? '  ↳ ' : '';
    return result ? `${indent}${mark} ${summary} → ${result}` : `${indent}${mark} ${summary}`;
  }

  // Reasoning is off by default: it is the noisiest part of the stream and
  // would bury the tool log it is interleaved with.
  if (event.type === 'plan_thinking') {
    if (!options.verbose) return null;
    const text = oneLine(String(event.text ?? ''), THINKING_CHARS);
    return text ? `  · ${text}` : null;
  }

  return null;
}

/** Whether the line replaces the transient status line or scrolls away above it. */
export function isTransient(event: WsEvent): boolean {
  return event.type === 'research_step';
}
