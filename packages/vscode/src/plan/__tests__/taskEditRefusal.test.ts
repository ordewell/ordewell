import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { PlanEditError, type CardEdit } from '@ordewell/core';
import { handleTaskEdit, type PlanManagerDeps } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

function hostOf(cardEdit: ReturnType<typeof vi.fn>, plan: { status: string; tasks: unknown[] }) {
  const chatProvider = { showPlan: vi.fn() };
  const d = {
    session: { cardEdit, planState: plan },
    chatProvider, getCurrentPlan: () => plan, setCurrentPlan: vi.fn(), persistState: vi.fn(), saveCurrentSession: vi.fn(),
  } as unknown as PlanManagerDeps;
  return { d, chatProvider };
}

// The host hands the card's edit to the Session whole: which tasks it may
// reach while a run holds the editors is the Session's rule (see
// cardEditPrecondition.test.ts in core), the same one every surface gets.
describe('a task card edit', () => {
  beforeEach(() => showWarningMessage.mockReset());

  const plan = { status: 'running', tasks: [] };

  it.each<CardEdit>([
    { kind: 'runner', runner: 'codex' },
    { kind: 'model', assignment: { modelId: 'haiku', modelLabel: 'Haiku' } },
    { kind: 'mode', mode: 'plan' },
    { kind: 'prompt', prompt: 'Do it differently' },
    { kind: 'dependencies', dependencies: ['t2'] },
    { kind: 'skills', skills: ['tdd'] },
    { kind: 'ops', ops: true },
  ])('reaches the Session as a %o and re-shows the plan', async (edit) => {
    const cardEdit = vi.fn();
    const { d, chatProvider } = hostOf(cardEdit, plan);

    await handleTaskEdit('t1', edit, d);

    expect(cardEdit).toHaveBeenCalledWith('t1', edit);
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
  });

  it('shows the session\'s reason when it refuses, and re-shows the plan as it stands', async () => {
    const reason = '"Build" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner\'s own /model';
    const { d, chatProvider } = hostOf(vi.fn().mockRejectedValue(new PlanEditError(reason)), plan);

    await handleTaskEdit('t1', { kind: 'model', assignment: { modelId: 'haiku', modelLabel: 'Haiku' } }, d);

    expect(showWarningMessage).toHaveBeenCalledWith(reason);
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
  });
});
