import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LeaseHost, loadSession, saveSession, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

const SESSION = 'session-user-actions';

/** A run at work, as its holder saved it: one attempt in progress on an isolated run. */
function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-10-23T23:12:07.000Z',
    tasks: [
      {
        id: 't1', order: 1, title: 'Fix the run engine', type: 'ai', status: 'in_progress',
        description: 'd', prompt: 'fix it', dependencies: [], assignedRunner: 'opencode', subtasks: [],
      },
    ],
    isolation: {
      run: { id: 'run-1', workspaceRoot: '/ws', repos: [], shared: [], sharedRepos: [], tasks: {} },
      resolvers: {},
    },
  } as unknown as LegacyPlanState;
}

/**
 * Where a user's git action learns whether a run is live, and where its line
 * goes (ADR-0062 G6, G7): the pool that holds the session answers from the
 * session; any other asks the lease and the saved record, and leaves its line
 * for the holder to fold. Neither takes the lease.
 */
describe('a user git action against the pool', () => {
  let workspace: string;
  let hostA: LeaseHost;
  let hostB: LeaseHost;
  let holder: OrchestratorPool;
  let other: OrchestratorPool;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-user-actions-'));
    mkdirSync(join(workspace, '.git'));
    hostA = new LeaseHost({ id: 'host-a', kind: () => ({ kind: 'daemon', port: 3742 }) });
    hostB = new LeaseHost({ id: 'host-b', kind: () => ({ kind: 'daemon', port: 49558 }) });
    holder = new OrchestratorPool({ leaseHost: hostA });
    other = new OrchestratorPool({ leaseHost: hostB });
    saveSession(savedPlan(), 'Improve the codebase', workspace, SESSION);
  });

  afterEach(() => {
    holder.destroyAll();
    other.destroyAll();
    hostA.releaseAll();
    hostB.releaseAll();
    rmSync(workspace, { recursive: true, force: true });
  });

  const plan = () => loadSession(SESSION, workspace)!.plan;
  const lines = () => (plan().conversationHistory ?? []).filter((m) => m.kind === 'system').map((m) => m.content);

  it('asks the holding session itself, never the saved record', () => {
    holder.adoptSavedSession(SESSION, workspace);
    // Adopting settles the saved in-progress attempt; this host knows nothing is at work.
    expect(holder.userRunIsLive(SESSION, workspace, savedPlan())).toBe(false);
  });

  it('judges a session another host holds by its lease and saved record, and one nobody holds as settled', async () => {
    holder.adoptSavedSession(SESSION, workspace);
    expect(other.userRunIsLive(SESSION, workspace, savedPlan())).toBe(true);
    expect(other.userRunIsLive(SESSION, workspace, { ...savedPlan(), tasks: [] })).toBe(false);
    expect(other.hasSession(SESSION)).toBe(false);

    await holder.close(SESSION);
    expect(other.userRunIsLive(SESSION, workspace, savedPlan())).toBe(false);
  });

  it('takes the holder\'s word that its run is live where the saved record shows nothing at work: a start pending, a Merge all', () => {
    // Another host's Session, its run live only in its memory.
    let live = true;
    hostA.lease(() => undefined, () => live).claim(SESSION, workspace);
    const settledPlan = { ...savedPlan(), tasks: [] };

    expect(other.userRunIsLive(SESSION, workspace, settledPlan)).toBe(true);

    live = false;
    hostA.beat();
    expect(other.userRunIsLive(SESSION, workspace, settledPlan)).toBe(false);
  });

  it('records into the held session\'s timeline straight away', () => {
    holder.adoptSavedSession(SESSION, workspace);
    holder.recordUserAction(SESSION, workspace, 'You committed "fix" on main.');
    expect(lines()).toContain('You committed "fix" on main.');
  });

  it('leaves a line from another host for the holder, which folds it when it next adopts the session', () => {
    holder.adoptSavedSession(SESSION, workspace);
    other.recordUserAction(SESSION, workspace, 'You pulled from origin/main on main.');
    expect(lines()).not.toContain('You pulled from origin/main on main.');
    expect(other.hasSession(SESSION)).toBe(false);

    holder.destroy(SESSION);
    holder.adoptSavedSession(SESSION, workspace);
    expect(lines()).toContain('You pulled from origin/main on main.');
  });
});
