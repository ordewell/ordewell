import type { DisplayBlock } from './blocks';
import { hasLongReport, REPORT_PREVIEW_LINES } from './wakeUp';

/**
 * Whether the conversation holds anything the collapsed view hides — thinking,
 * a command row's arguments and output, a subagent's children and digest,
 * what a task's runner loaded, what Ordewell added to a task's first message, a research report too long to show whole, a
 * handoff's long report. The TUI's ctrl+o is its one expansion control
 * (ADR-0017, X1), so it is offered only when it would do something.
 */
export function hasHiddenDetail(blocks: readonly DisplayBlock[]): boolean {
  return blocks.some((b) => b.type === 'thinking' || b.type === 'tool' || b.type === 'subagent' || b.type === 'runner_loaded'
    || (b.type === 'message' && ((b.role === 'wake_up' && hasLongReport(b.text)) || (b.sections?.length ?? 0) > 0))
    || (b.type === 'handoff' && (b.handoff.report?.replace(/\n+$/, '').split('\n').length ?? 0) > REPORT_PREVIEW_LINES));
}
