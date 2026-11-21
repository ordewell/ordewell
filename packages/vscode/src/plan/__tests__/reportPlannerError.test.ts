import { describe, it, expect, vi } from 'vitest';
import { PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError } from '@ordewell/core';
import { reportPlannerError, type PlanManagerDeps } from '../PlanManager';

function harness() {
  const showError = vi.fn();
  const deps = { chatProvider: { showError } } as unknown as PlanManagerDeps;
  return { deps, showError };
}

describe('reportPlannerError', () => {
  it('reports a real failure whose message happens to mention "aborted"', () => {
    const { deps, showError } = harness();
    reportPlannerError(new Error('runner exited: transaction aborted'), deps);
    expect(showError).toHaveBeenCalledWith('Planner failed: runner exited: transaction aborted');
  });

  it('stays quiet for an AbortError', () => {
    const { deps, showError } = harness();
    reportPlannerError(new DOMException('Aborted', 'AbortError'), deps);
    expect(showError).not.toHaveBeenCalled();
  });

  it('stays quiet for a turn discarded because the session it answered was left', () => {
    const { deps, showError } = harness();
    reportPlannerError(new PlannerTurnDiscardedError(), deps);
    expect(showError).not.toHaveBeenCalled();
  });

  it('stays quiet for a stop the backend reported as a thrown error', () => {
    const { deps, showError } = harness();
    reportPlannerError(new PlannerTurnStoppedError({ cause: new Error('Request was aborted.') }), deps);
    expect(showError).not.toHaveBeenCalled();
  });

  it('words a planner the session refused with the chat\'s own commands, not as a failure', () => {
    const { deps, showError } = harness();
    reportPlannerError(new PlannerNotReadyError({ code: 'no_model', provider: 'openrouter', label: 'OpenRouter' }), deps);
    expect(showError).toHaveBeenCalledWith('No planner model selected for OpenRouter. Run /planner and pick a model for OpenRouter.');
  });
});
