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

  // Refusing a goal must not cost the plan the session holds now.
  it.each([
    ['startPlanning', (session: ReturnType<typeof liveSession>['session']) => session.startPlanning('new goal', ['opencode'])],
    ['generatePlan', (session: ReturnType<typeof liveSession>['session']) => session.generatePlan('new goal', ['opencode'])],
  ])('leaves the plan as it was when %s names no enabled runner', async (_name, refuse) => {
    const { session } = liveSession();
    const held = await session.startPlanning('first goal', ['claude-code']);

    await expect(refuse(session)).rejects.toThrow('None of the requested runners are enabled');

    expect(session.planState).toBe(held);
    expect(session.planState?.conversationHistory?.[0]?.content).toBe('first goal');
  });
  // F11 of the first-run audit: the refusal named the wall and no way past it.
  it('says how to go on when the goal names a runner that is not enabled: the ones that are, or turning one on', async () => {
    const { session } = liveSession();
    await expect(session.startPlanning('goal', ['opencode'])).rejects.toThrow(
      'None of the requested runners are enabled. Send the goal again to plan for the enabled one (Claude Code), or turn on another under Runners (/runners in the terminal UI).',
    );
  });

  it('says how to go on when no runner is enabled at all: turn one on, or install a coding agent and detect again', async () => {
    const { session, setEnabled } = liveSession();
    setEnabled([]);
    await expect(session.startPlanning('goal')).rejects.toThrow(
      'None of the requested runners are enabled. Turn one on under Runners (/runners in the terminal UI), or install a coding agent such as Claude Code or Codex and run /refresh.',
    );
  });
});
