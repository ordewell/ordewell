import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveSession, type LegacyPlanState, type ITerminalRunner } from '@ordewell/core';

const poolAwareRunnerCtor = vi.fn();
vi.mock('../../adapters/PoolAwareRunner', () => ({
  PoolAwareRunner: vi.fn().mockImplementation((...args: unknown[]) => {
    poolAwareRunnerCtor(...args);
    return { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
  }),
}));

import { OrchestratorPool } from '../orchestratorPool';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-07-21T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'opencode', subtasks: [] },
    ],
  } as unknown as LegacyPlanState;
}

describe('OrchestratorPool shared runner injection', () => {
  let workspace: string;

  beforeEach(() => {
    poolAwareRunnerCtor.mockClear();
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-runner-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('passes an injected shared runner into every session it creates', () => {
    const runner = { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() } as ITerminalRunner;
    const pool = new OrchestratorPool({ runner });

    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-shared');
    pool.adoptSavedSession(meta.id, workspace);

    expect(poolAwareRunnerCtor).toHaveBeenCalledWith(expect.any(String), expect.any(Function), runner);
  });

  it('defaults to no injected runner, preserving today\'s per-session HeadlessRunner behavior', () => {
    const pool = new OrchestratorPool();

    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-default');
    pool.adoptSavedSession(meta.id, workspace);

    expect(poolAwareRunnerCtor).toHaveBeenCalledWith(expect.any(String), expect.any(Function), undefined);
  });
});
