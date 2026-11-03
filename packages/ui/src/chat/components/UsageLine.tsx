import React, { type ReactNode } from 'react';
import { contextMeterText, contextMeterTitle, costText, hasAccountLimits, modelCostTitle, subagentCostTitle } from '@ordewell/core/plan-utils';
import type { AccountLimitSnapshot, UsageBlock } from '@ordewell/core';
import AccountLimitRows from './AccountLimitRows';

/*
 * The planner's usage line (#53): the main model's context and the cost its
 * runner reported, pinned below the conversation. "Planner" is this footer's
 * own word — a task's footer draws the same meter without it — so it is added
 * here rather than to core's meter. Core words both, so the
 * surfaces agree; token counts stay in the ledger and are not drawn. The hovers
 * are the second question: exact counts, and which model cost what.
 *
 * It is also where the escalation inbox's control sits (ADR-0053), pinned to
 * the right end: the line is the one strip already between the conversation and
 * the composer, so a list of waits costs the panel no height. The measures
 * shrink and ellipsise before the control does, and with nothing else to show
 * the line is the control alone.
 */

export default function UsageLine({ block, limits, inbox }: { block?: UsageBlock; limits: readonly AccountLimitSnapshot[]; inbox?: ReactNode }) {
  const meter = contextMeterText(block?.contextFill);
  const cost = block && costText(block.totals);
  const agents = Object.entries(block?.bySubagent ?? {});
  const shownLimits = limits.filter(hasAccountLimits);
  if (!meter && !cost && agents.length === 0 && shownLimits.length === 0 && !inbox) return null;

  // Context, live limits, then cost, as the TUI draws them. The limits are not
  // a live region, so each measure either side of them is its own.
  return (
    <div className="usage-line">
      {meter && block?.contextFill && (
        <span className="usage-line-measures" role="status">
          <span className="usage-line-context" title={contextMeterTitle(block.contextFill)}>Planner {meter}</span>
        </span>
      )}
      {meter && shownLimits.length > 0 && ' · '}
      <AccountLimitRows limits={shownLimits} />
      {(meter || shownLimits.length > 0) && cost && ' · '}
      {cost && (
        <span className="usage-line-measures" role="status">
          <span className="usage-line-cost" title={block?.byModel && modelCostTitle(block.byModel)}>{cost}</span>
        </span>
      )}
      {(meter || cost || shownLimits.length > 0) && agents.length > 0 && ' · '}
      {agents.length > 0 && (
        <span className="usage-line-subagents" title={subagentCostTitle(block?.bySubagent ?? {})}>
          {agents.length} subagent{agents.length === 1 ? '' : 's'}
        </span>
      )}
      {inbox}
    </div>
  );
}
