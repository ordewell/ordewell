import { describe, it, expect, vi } from 'vitest';
import { handleSessionMessage } from '../PlanManager';
import type { PlanManagerDeps } from '../PlanManager';

function deps() {
  const chatProvider = { sendNewMessage: vi.fn(), showPlan: vi.fn() };
  const d = { session: {}, chatProvider, isGeneratingPlan: () => false } as unknown as PlanManagerDeps;
  return { d, chatProvider };
}

describe('worktree isolation messages (ADR-0013)', () => {
  it('tells the user why a run on a dirty tree did not start', () => {
    const { d, chatProvider } = deps();

    handleSessionMessage({ type: 'isolation_blocked', reason: 'dirty', message: 'Stash them, or run without isolation.' }, d);

    expect(chatProvider.sendNewMessage).toHaveBeenCalledWith('Stash them, or run without isolation.', expect.any(String));
  });
});
