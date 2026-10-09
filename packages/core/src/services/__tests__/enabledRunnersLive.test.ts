import { describe, it, expect, vi } from 'vitest';
import type { DiscoveredModel } from '../../models/Task';
import type { SessionRuntimeSettings } from '../createSession';
import { makeSession } from './sessionTestKit';

function models(...ids: string[]): DiscoveredModel[] {
  return ids.map((modelId) => ({ modelId, modelLabel: modelId, variants: [] }));
}

/** A session built with claude-code enabled, whose settings the test rewrites the way a settings write would. */
function liveSession() {
  let settings: SessionRuntimeSettings = {
    enabledRunners: ['claude-code'],
    modelAllowlist: { codex: ['codex-model'] },
  };
  const session = makeSession({
    aiService: {
      startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'What should it do?', researchLog: [] }),
      continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] }),
      hasActiveConversation: () => true,
    },
    modelResolver: {
      modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, models(`${r}-model`, `${r}-other`)]))),
    },
    settings: () => settings,
  });
  return {
    session,
    setEnabled: (runners: string[]) => { settings = { ...settings, enabledRunners: runners }; },
  };
}

describe('enabled runners read live', () => {
  it('lets planning start on a runner enabled after the session was built', async () => {
    const { session, setEnabled } = liveSession();

    setEnabled(['claude-code', 'codex']);
    const plan = await session.startPlanning('goal', ['codex']);

    expect(plan.runners).toEqual(['codex']);
  });

  it('shows a runner in the live catalog as soon as it is enabled, and drops it once disabled', async () => {
    const { session, setEnabled } = liveSession();
    await session.startPlanning('goal', ['claude-code']);

    setEnabled(['claude-code', 'codex']);
    const enabled = await session.liveCatalog();
    expect(enabled.runners).toEqual(['claude-code', 'codex']);
    expect(enabled.models.codex?.map((m) => m.modelId)).toEqual(['codex-model']);
    expect(enabled.models['claude-code']?.map((m) => m.modelId)).toEqual(['claude-code-model', 'claude-code-other']);

    setEnabled(['claude-code']);
    expect((await session.liveCatalog()).runners).toEqual(['claude-code']);
  });
});
