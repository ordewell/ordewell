import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAiService } from '../AiService';
import type { IConfig } from '../../interfaces/IConfig';
import { makeSession, fakeConfig, testWorkspace } from './sessionTestKit';

const created: { provider: string; service: IAiService; workspaceRoot?: () => string }[] = [];

vi.mock('../AiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AiService')>();
  return {
    ...actual,
    createAiService: vi.fn((config: IConfig, deps?: { workspaceRoot?: () => string }) => {
      const service = {
        reset: vi.fn(),
        hasActiveConversation: vi.fn().mockReturnValue(false),
        startConversation: vi.fn(),
        continueConversation: vi.fn(),
        researchAndPlan: vi.fn(),
        generatePlanDirect: vi.fn(),
        modifyPlan: vi.fn(),
        sendPlanningPrompt: vi.fn(),
      } as unknown as IAiService;
      created.push({ provider: config.aiProvider, service, workspaceRoot: deps?.workspaceRoot });
      return service;
    }),
  };
});

describe('Session planner backend', () => {
  beforeEach(() => { created.length = 0; });

  it('resolves the service for the provider configured at the time of use', () => {
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const session = makeSession({ config });

    expect(session.aiServiceInstance).toBe(created[0].service);
    expect(created).toHaveLength(1);
    expect(created[0].provider).toBe('claude-code');
  });

  it('rebuilds when the host switches planner mid-session, and releases the old one', () => {
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const session = makeSession({ config });
    const first = session.aiServiceInstance;

    (config as { aiProvider: IConfig['aiProvider'] }).aiProvider = 'opencode';
    const second = session.aiServiceInstance;

    expect(second).not.toBe(first);
    expect(created.map((c) => c.provider)).toEqual(['claude-code', 'opencode']);
    // A harness planner holds an agent process; dropping the reference without
    // reset() leaks it.
    expect(first.reset).toHaveBeenCalled();
  });

  it('keeps one service while the provider is unchanged', () => {
    const session = makeSession({ config: fakeConfig({ aiProvider: 'opencode' }) });
    expect(session.aiServiceInstance).toBe(session.aiServiceInstance);
    expect(created).toHaveLength(1);
  });

  it('gives a harness planner the session workspace, not the host process cwd', () => {
    const session = makeSession({ config: fakeConfig({ aiProvider: 'opencode' }) });
    void session.aiServiceInstance;
    expect(created[0].workspaceRoot?.()).toBe(testWorkspace);
  });

  it('never replaces an injected service', () => {
    const injected = { reset: vi.fn() };
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const session = makeSession({ config, aiService: injected });

    const first = session.aiServiceInstance;
    (config as { aiProvider: IConfig['aiProvider'] }).aiProvider = 'opencode';

    expect(session.aiServiceInstance).toBe(first);
    expect(created).toHaveLength(0);
  });
});
