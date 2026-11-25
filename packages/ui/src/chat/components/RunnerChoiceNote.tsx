import React from 'react';
import type { RunnerChoice } from '@ordewell/core/plan-utils';
import PlannerLoginAction from './PlannerLogin';

/** What a row's recovery control runs, and whether that runner's login is under way. */
export interface RunnerRecoveryView {
  run: () => void;
  pending?: boolean;
}

/** Each recovery's accessible name: the visible label alone does not say which agent it acts on. */
function recoveryName(kind: NonNullable<RunnerChoice['recovery']>['kind'], label: string, pending: boolean): string {
  switch (kind) {
    case 'sign-in': return pending ? `Signing in to ${label}` : `Sign in to ${label}`;
    case 'add-key': return `Add a key for ${label}`;
    case 'set-up': return pending ? `Setting up ${label}` : `Set up ${label} with a provider API key`;
    case 'refresh-models': return `Refresh models for ${label}`;
    case 'retry': return `Retry loading models for ${label}`;
  }
}

/**
 * A picker row's short status and its one way back, drawn beside the row
 * (ADR-0052). The words come from core's `runnerChoice`; `tone` only
 * reinforces them. The recovery is its own button, so it stays reachable by
 * keyboard and screen reader while the row itself refuses a new pick.
 */
export default function RunnerChoiceNote({ id, choice, label, title, recovery, className = '' }: {
  /** The status's id, which the row's own control names in `aria-describedby`. */
  id: string;
  /** The recovery's placement class, beside the shared capsule look. */
  className?: string;
  choice: RunnerChoice;
  label: string;
  /** The longer way in, for the status's tooltip. */
  title?: string;
  /** Absent where this host has no action for the recovery: the status is still said. */
  recovery?: RunnerRecoveryView;
}) {
  if (!choice.text) return null;
  const pending = recovery?.pending === true;
  return (
    <>
      <span id={id} className={`runner-choice-status tone-${choice.tone}`} title={title}>{choice.text}</span>
      {choice.recovery && recovery && (
        <PlannerLoginAction
          className={`planner-pill-login runner-choice-recovery tone-${choice.tone}${className ? ` ${className}` : ''}`}
          label={choice.recovery.label}
          onLogIn={recovery.run}
          pending={pending}
          {...(choice.recovery.kind === 'set-up' ? { pendingLabel: 'Setting up…' } : {})}
          ariaLabel={recoveryName(choice.recovery.kind, label, pending)}
          title={recoveryName(choice.recovery.kind, label, pending)}
        />
      )}
    </>
  );
}
