import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listSessions, saveSession, Session, WorkspaceNotFoundError, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

function savedPlan(over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-07-21T10:00:00.000Z',
    tasks: [
      {
        id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'completed',
        description: 'd', dependencies: [], assignedRunner: 'opencode', subtasks: [],
      },
      {
        id: 't2', order: 2, title: 'Wire it up', type: 'ai', status: 'pending',
        description: 'd', dependencies: ['t1'], assignedRunner: 'opencode', subtasks: [],
      },
    ],
    ...over,
  } as unknown as LegacyPlanState;
}

describe('OrchestratorPool.adoptSavedSession', () => {
  let workspace: string;
  let pool: OrchestratorPool;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-'));
    pool = new OrchestratorPool();
  });

  afterEach(() => {
    pool.destroyAll();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('makes a session saved on disk addressable', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    expect(pool.hasSession(meta.id)).toBe(false);

    pool.adoptSavedSession(meta.id, workspace);

    expect(pool.hasSession(meta.id)).toBe(true);
    expect(() => pool.session(meta.id)).not.toThrow();
  });

  it('restores the saved plan, not an empty one', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    const plan = pool.adoptSavedSession(meta.id, workspace);

    expect(plan.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(pool.getPlan(meta.id)?.tasks).toHaveLength(2);
  });

  it('restores the goal so the planner can be resumed', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);

    expect(pool.getGoal(meta.id)).toBe('Rate limiting');
  });

  it('keeps writing to the same session file rather than forking a new one', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);

    expect(pool.session(meta.id).sessionId).toBe('session-saved');
  });

  it('lets task control reach a task from the restored plan', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);

    await expect(pool.session(meta.id).markTaskComplete('t2')).resolves.not.toThrow();
  });

  // persist() derives the filename from goal + createdAt + id, so adopting a
  // session must land on the file it came from rather than forking a second
  // entry with the same id.
  it('does not fork a second file for the session it adopted', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    const before = readdirSync(join(workspace, '.ordewell', 'sessions'));

    pool.adoptSavedSession(meta.id, workspace);

    expect(readdirSync(join(workspace, '.ordewell', 'sessions'))).toEqual(before);
  });

  it('keeps the saved plan visible to a later listing', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);

    const listed = listSessions(workspace);
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('session-saved');
  });

  it('refuses a session id that is not on disk', () => {
    expect(() => pool.adoptSavedSession('session-nope', workspace)).toThrow('Session not found');
  });

  it('leaves an already-live session alone instead of resetting it', () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    const live = pool.session(meta.id);

    pool.adoptSavedSession(meta.id, workspace);

    expect(pool.session(meta.id)).toBe(live);
  });
});

// A workspace that does not exist on disk (a shell's stale cwd, a typo'd
// --workspace) must be refused before it ever reaches a harness adapter's
// `spawn` — there it surfaces as an ENOENT that reads as a missing agent
// binary rather than a missing directory.
describe('OrchestratorPool workspace validation', () => {
  let pool: OrchestratorPool;
  const missing = '/definitely/does/not/exist/ordewell-workspace';

  beforeEach(() => {
    pool = new OrchestratorPool();
  });

  afterEach(() => {
    pool.destroyAll();
  });

  it('rejects generatePlan for a workspace that does not exist', async () => {
    await expect(
      pool.generatePlan('session-missing-ws', 'Add a widget', ['claude-code'], missing),
    ).rejects.toThrow(WorkspaceNotFoundError);
    expect(pool.hasSession('session-missing-ws')).toBe(false);
  });

  it('rejects startPlanning for a workspace that does not exist', async () => {
    await expect(
      pool.startPlanning('session-missing-ws-2', 'Add a widget', ['claude-code'], missing),
    ).rejects.toThrow(WorkspaceNotFoundError);
    expect(pool.hasSession('session-missing-ws-2')).toBe(false);
  });

  it('names the missing path in the error', async () => {
    const err = await pool
      .generatePlan('session-missing-ws-3', 'Add a widget', ['claude-code'], missing)
      .catch((e) => e);
    expect(err.message).toContain(missing);
  });
});

// Research inside generatePlan/startPlanning can raise an approval and await
// the answer, and that answer arrives over POST /api/approvals/:sessionId —
// which 404s (via pool.hasSession) until the session is registered. Both
// methods used to register only after the awaited call resolved, so the very
// first approval of a session could never be delivered until its 5-minute
// timeout. `Session.prototype.generatePlan`/`startPlanning` are stubbed with a
// deferred promise so the registration ordering can be observed without a
// real planner call.
describe('OrchestratorPool session registration ordering', () => {
  let workspace: string;
  let pool: OrchestratorPool;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-'));
    pool = new OrchestratorPool();
  });

  afterEach(() => {
    pool.destroyAll();
    rmSync(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers the session before generatePlan resolves, so a mid-research approval is answerable', async () => {
    let resolvePlan!: (v: LegacyPlanState) => void;
    const deferred = new Promise<LegacyPlanState>((resolve) => { resolvePlan = resolve; });
    vi.spyOn(Session.prototype, 'generatePlan').mockReturnValue(deferred);

    const call = pool.generatePlan('session-inflight', 'Add a widget', ['claude-code'], workspace);
    await Promise.resolve(); // let the mocked call start before we assert

    expect(pool.hasSession('session-inflight')).toBe(true);

    resolvePlan(savedPlan());
    await call;
  });

  it('registers the session before startPlanning resolves, so a mid-research approval is answerable', async () => {
    let resolvePlan!: (v: LegacyPlanState) => void;
    const deferred = new Promise<LegacyPlanState>((resolve) => { resolvePlan = resolve; });
    vi.spyOn(Session.prototype, 'startPlanning').mockReturnValue(deferred);

    const call = pool.startPlanning('session-inflight-2', 'Add a widget', ['claude-code'], workspace);
    await Promise.resolve();

    expect(pool.hasSession('session-inflight-2')).toBe(true);

    resolvePlan(savedPlan());
    await call;
  });
});

describe('OrchestratorPool.cancelPlanning', () => {
  let workspace: string;
  let pool: OrchestratorPool;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-'));
    pool = new OrchestratorPool();
  });

  afterEach(() => {
    pool.destroyAll();
    rmSync(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('aborts the signal passed into the in-flight planning turn', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolvePlan!: (v: LegacyPlanState) => void;
    const deferred = new Promise<LegacyPlanState>((resolve) => { resolvePlan = resolve; });
    vi.spyOn(Session.prototype, 'startPlanning').mockImplementation(async (_goal, _runners, options) => {
      capturedSignal = options?.signal;
      return deferred;
    });

    const call = pool.startPlanning('session-abort', 'Add a widget', ['claude-code'], workspace);
    await Promise.resolve();

    expect(pool.cancelPlanning('session-abort')).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    resolvePlan(savedPlan());
    await call;
  });

  it('is a no-op when nothing is planning for that session', () => {
    expect(pool.cancelPlanning('nobody-home')).toBe(false);
  });

  it('clears the controller once the turn settles, so a later cancel finds nothing to abort', async () => {
    vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue(savedPlan());

    await pool.startPlanning('session-settled', 'Add a widget', ['claude-code'], workspace);

    expect(pool.cancelPlanning('session-settled')).toBe(false);
  });
});
