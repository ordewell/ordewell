import { describe, it, expect, vi } from 'vitest';
import { createTask, type DiscoveredModel } from '../../models/Task';
import type { ModelResolver } from '../ModelResolver';
import type { SessionRuntimeSettings } from '../createSession';
import { makeSession } from './sessionTestKit';

function models(...ids: string[]): DiscoveredModel[] {
  return ids.map((modelId) => ({ modelId, modelLabel: modelId, variants: [] }));
}

/**
 * A session planned under `allowlist`, whose settings the test can rewrite
 * mid-conversation the way a settings write from any surface would.
 */
async function plannedSession(opts: {
  discovered: string[];
  allowlist?: string[];
  resolverCache?: () => DiscoveredModel[];
  continueReplies: unknown[];
}) {
  let settings: SessionRuntimeSettings = {
    modelAllowlist: opts.allowlist ? { 'claude-code': opts.allowlist } : undefined,
  };
  const continueConversation = vi.fn();
  for (const reply of opts.continueReplies) continueConversation.mockResolvedValueOnce(reply);
  continueConversation.mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
  const modelResolver: Pick<ModelResolver, 'modelsForRunners' | 'getCachedRunnerModels'> = {
    modelsForRunners: vi.fn().mockResolvedValue({ 'claude-code': models(...opts.discovered) }),
    getCachedRunnerModels: vi.fn(() => opts.resolverCache?.() ?? []),
  };
  const session = makeSession({
    aiService: {
      startConversation: vi.fn().mockResolvedValue({
        kind: 'plan',
        tasks: [createTask({ id: 't1', order: 1, title: 'T', prompt: 'p', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'claude-sonnet-4' } })],
        text: '',
        researchLog: [],
      }),
      continueConversation,
      hasActiveConversation: () => true,
    },
    modelResolver,
    settings: () => settings,
  });
  await session.startPlanning('goal', ['claude-code']);
  return {
    session,
    continueConversation,
    setAllowlist: (ids: string[] | undefined) => {
      settings = { ...settings, modelAllowlist: ids ? { 'claude-code': ids } : undefined };
    },
  };
}

const assignOpus = {
  kind: 'task_ops',
  ops: [{ op: 'update', taskId: '#1', changes: { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'claude-opus-4' } } }],
  text: '{"taskOps":[...]}',
  researchLog: [],
};

describe('model allowlist changed mid-session', () => {
  it('lets the planner assign a newly allowed model the session never discovered', async () => {
    const { session, continueConversation, setAllowlist } = await plannedSession({
      discovered: ['claude-sonnet-4'],
      allowlist: ['claude-sonnet-4'],
      continueReplies: [assignOpus],
    });

    setAllowlist(['claude-sonnet-4', 'claude-opus-4']);
    const plan = await session.continueConversation('use opus');

    expect(String(continueConversation.mock.calls[0][0])).toContain('claude-opus-4');
    expect(plan.tasks[0].assignedModel?.modelId).toBe('claude-opus-4');
  });

  it('shows models the resolver discovered after the session started', async () => {
    let cache: DiscoveredModel[] = [];
    const { session, continueConversation } = await plannedSession({
      discovered: ['claude-sonnet-4'],
      resolverCache: () => cache,
      continueReplies: [],
    });

    cache = models('claude-sonnet-4', 'claude-opus-4');
    await session.continueConversation('what can you use?');

    expect(String(continueConversation.mock.calls[0][0])).toContain('claude-opus-4');
  });

  it('lifts the restriction when the allowlist is cleared entirely', async () => {
    const { session, continueConversation, setAllowlist } = await plannedSession({
      discovered: ['claude-sonnet-4', 'claude-opus-4'],
      allowlist: ['claude-sonnet-4'],
      continueReplies: [assignOpus],
    });

    setAllowlist(undefined);
    const plan = await session.continueConversation('use opus');

    expect(String(continueConversation.mock.calls[0][0])).toContain('claude-opus-4');
    expect(plan.tasks[0].assignedModel?.modelId).toBe('claude-opus-4');
  });
});
