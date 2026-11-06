import { useState } from 'react';
import { Badge, Button } from '@ordewell/ui/design';
import type { GlobalRunSettings } from '@ordewell/core';
import { DELEGATION_NETWORK_RISK, keptDelegationBudget, SHAPE_LIMITS, SUBPLANNER_ACCOUNTING, SUBPLANNER_CHILD } from '@ordewell/core/plan-utils';
import NumberField from './NumberField';

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const budgetHint = (n: number): string => `A tree of plans may spend up to ${plural(n, 'token', 'tokens')}.`;

/**
 * Subplanners (ADR-0055 D19, D21): one switch, a tree budget of 0 being off.
 * Turning off writes only the budget, so the daemon keeps it and the tree's
 * shape for next time. Turning on asks first, and a first budget is the
 * user's to type: the daemon offers no default for it.
 */
export function Subplanners({ run, busy, onChange }: {
  run: GlobalRunSettings;
  busy: boolean;
  onChange(change: Partial<GlobalRunSettings>): Promise<void>;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const on = run.delegationTokens > 0;
  return (
    <>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={on || asking}
          disabled={busy}
          onChange={(event) => {
            if (event.target.checked) setAsking(true);
            else if (asking) setAsking(false);
            else void onChange({ delegationTokens: 0 });
          }}
        />
        <span className="settings-toggle-label">Subplanners <Badge tone="neutral">Experimental</Badge></span>
        <span className="settings-hint">A plan&apos;s task may be handed to a subplanner, which plans and runs a child plan of its own.</span>
      </label>
      {asking && !on && (
        <TurnOn
          kept={keptDelegationBudget(run)}
          onCancel={() => setAsking(false)}
          onTurnOn={(delegationTokens) => { void onChange({ delegationTokens }).finally(() => setAsking(false)); }}
        />
      )}
      {on && (
        <div className="settings-subplanners">
          <NumberField
            label="Tree budget"
            value={run.delegationTokens}
            min={1}
            busy={busy}
            hint={(n) => `${budgetHint(n)} Shared by every plan in the tree.`}
            onCommit={(delegationTokens) => { void onChange({ delegationTokens }); }}
          />
          <NumberField
            label="Maximum depth"
            value={run.delegationDepth}
            min={1}
            max={SHAPE_LIMITS.depth.hard}
            busy={busy}
            hint={(n) => `Child plans may open up to ${plural(n, 'level', 'levels')} below your plan, at most ${SHAPE_LIMITS.depth.hard}.`}
            onCommit={(delegationDepth) => { void onChange({ delegationDepth }); }}
          />
          <NumberField
            label="Delegated tasks per plan"
            value={run.delegatedTasksPerPlan}
            min={1}
            max={SHAPE_LIMITS.delegatedTasks.hard}
            busy={busy}
            hint={(n) => `Any one plan may hand up to ${plural(n, 'task', 'tasks')} to subplanners, at most ${SHAPE_LIMITS.delegatedTasks.hard}.`}
            onCommit={(delegatedTasksPerPlan) => { void onChange({ delegatedTasksPerPlan }); }}
          />
          <NumberField
            label="Tasks per child plan"
            value={run.tasksPerChildPlan}
            min={1}
            max={SHAPE_LIMITS.tasksPerPlan.hard}
            busy={busy}
            hint={(n) => `A child plan may hold up to ${plural(n, 'task', 'tasks')}, at most ${SHAPE_LIMITS.tasksPerPlan.hard}. Your own plan has no such limit.`}
            onCommit={(tasksPerChildPlan) => { void onChange({ tasksPerChildPlan }); }}
          />
        </div>
      )}
    </>
  );
}

/** The confirmation CONTEXT.md's Delegation entry asks for: what a subplanner may do unread, and how the budget is counted. */
function TurnOn({ kept, onCancel, onTurnOn }: { kept: number | null; onCancel(): void; onTurnOn(tokens: number): void }): JSX.Element {
  const [typed, setTyped] = useState('');
  const tokens = kept ?? Number(typed);
  return (
    <div className="settings-confirm settings-subplanners-confirm" role="group" aria-label="Turn Subplanners on">
      <span className="settings-confirm-text">Turn Subplanners on?</span>
      <p className="settings-hint">{SUBPLANNER_CHILD} {DELEGATION_NETWORK_RISK}</p>
      <p className="settings-hint">{SUBPLANNER_ACCOUNTING}</p>
      {kept === null ? (
        <label className="settings-field">
          <span className="settings-label">Tree budget</span>
          <span className="settings-number">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              placeholder="Tokens"
              onChange={(event) => setTyped(event.target.value.replace(/\D/g, '').slice(0, 15))}
            />
            <span className="settings-hint">{tokens > 0 ? budgetHint(tokens) : 'How many tokens the whole tree of plans may spend.'}</span>
          </span>
        </label>
      ) : (
        <p className="settings-hint">{budgetHint(kept)}</p>
      )}
      <div className="settings-confirm-actions">
        <Button size="sm" variant="primary" disabled={!(tokens > 0)} onClick={() => onTurnOn(tokens)}>Turn on</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
