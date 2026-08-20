import { describe, it, expect, vi } from 'vitest';
import type { DiscoveredModel } from '../../models/Task';
import type { LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace } from './sessionTestKit';

function models(...ids: string[]): DiscoveredModel[] {
  return ids.map((modelId) => ({ modelId, modelLabel: modelId, variants: [] }));
}

function emptyPlan(runners: LegacyPlanState['runners'] = ['claude-code']): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners,
    lastUpdated: new Date().toISOString(),
  };
}

describe('catalog block — always-on, allowlist-filtered', () => {
  it('is present on the first turn, before any task exists', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(emptyPlan(), 'goal', testWorkspace, { persist: false });

    await session.continueConversation('go on');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('<available_models>');
    expect(outgoing).toContain('<available_task_modes>');
    expect(outgoing).not.toContain('<current_plan>');
  });

  it('never shows a model the allowlist excludes, even though it was discovered', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
      },
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({
          'claude-code': models('claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4'),
        }),
      },
      settings: () => ({
        tddEnabled: false,
        modelAllowlist: { 'claude-code': ['claude-sonnet-4'] },
      }),
    });

    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('go on');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('claude-sonnet-4');
    expect(outgoing).not.toContain('claude-opus-4');
    expect(outgoing).not.toContain('claude-haiku-4');
  });

  it('lists each selected runner\'s task modes with the default marked', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(emptyPlan(['claude-code']), 'goal', testWorkspace, { persist: false });

    await session.continueConversation('go on');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    const modeLine = outgoing.split('\n').find((l) => l.startsWith('claude-code:') && l.includes('(default)'));
    expect(modeLine).toContain('bypassPermissions (default)');
    expect(modeLine).toContain('acceptEdits');
    expect(modeLine).toContain('default');
    expect(modeLine).toContain('plan');
  });

  it('only lists runners selected for this plan, not every enabled runner', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: { continueConversation, hasActiveConversation: () => true },
    });
    session.loadPlan(emptyPlan(['claude-code']), 'goal', testWorkspace, { persist: false });

    await session.continueConversation('go on');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).not.toMatch(/^codex:/m);
    expect(outgoing).not.toMatch(/^opencode:/m);
  });

  it('caps the per-runner model list and states how many more exist', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const many = Array.from({ length: 120 }, (_, i) => `model-${i}`);
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
      },
      modelResolver: {
        modelsForRunners: vi.fn().mockResolvedValue({ 'claude-code': models(...many) }),
      },
    });

    await session.startPlanning('goal', ['claude-code']);
    await session.continueConversation('go on');

    const outgoing = String(continueConversation.mock.calls[0][0]);
    expect(outgoing).toContain('model-0');
    expect(outgoing).not.toContain('model-119');
    expect(outgoing).toMatch(/\+\d+ more/);
  });
});
