import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  AlreadyExecutingError,
  ConversationBusyError,
  ConversationEditError,
  NoPlanError,
  PlanEditError,
  PlannerNotReadyError,
  PlannerTurnDiscardedError,
  PlannerTurnStoppedError,
  SessionNotFoundError,
  TaskControlError,
  UserGitError,
  WorkspaceNotAProjectError,
  WorkspaceNotFoundError,
} from '@ordewell/core';
import { failure } from '../errors';

async function answer(err: unknown, options?: Parameters<typeof failure>[3]) {
  const app = new Hono();
  app.get('/', (c) => failure(c, err, 'test', options));
  const res = await app.request('/');
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('failure', () => {
  // These tests silence console.error; left in place, a later test's genuine
  // fault would be swallowed and its log assertion could not fail.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [new SessionNotFoundError(), 404, 'session_not_found'],
    [new NoPlanError('execute'), 400, 'no_plan'],
    [new NoPlanError('review'), 400, 'no_plan'],
    [new AlreadyExecutingError(), 409, 'already_executing'],
    [new WorkspaceNotFoundError('/nope'), 400, 'workspace_not_found'],
    [new ConversationBusyError('rewind'), 409, 'conversation_busy'],
    [new ConversationEditError('no such message'), 400, 'refused'],
    [new PlanEditError('invalid edit'), 400, 'refused'],
    [new TaskControlError('not running'), 400, 'refused'],
    [new PlannerTurnStoppedError({ cause: new Error('Request was aborted.') }), 409, 'planner_turn_stopped'],
    [new PlannerTurnDiscardedError(), 409, 'planner_turn_discarded'],
  ])('maps %s to %i %s', async (err, status, code) => {
    const res = await answer(err);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: err.message, code });
  });

  it('carries the planner_not_ready reason as data, so a client can word it in its own commands', async () => {
    const reason = { code: 'no_key', provider: 'openrouter', label: 'OpenRouter', keyEnvVar: 'OPENROUTER_API_KEY' } as const;
    const err = new PlannerNotReadyError(reason);

    const res = await answer(err);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: err.message, code: 'planner_not_ready', plannerNotReady: reason });
  });

  it('carries the refused directory with workspace_not_a_project', async () => {
    const res = await answer(new WorkspaceNotAProjectError('/bare'));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'workspace_not_a_project', workspace: '/bare' });
  });

  it('does not log a stack for a stopped or discarded planner turn', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.mockClear();

    await answer(new PlannerTurnStoppedError());
    await answer(new PlannerTurnDiscardedError());

    expect(log).not.toHaveBeenCalled();
  });

  it('never classifies by message: a plain Error with a known wording is a fault', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await answer(new Error('Session not found'));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Session not found' });
  });

  it('takes the route\'s fallback for what it does not know, and logs only a 5xx', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await answer(new Error('boom'), { fallback: 400 })).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
    expect((await answer(new Error('boom'))).status).toBe(500);
    expect(log).toHaveBeenCalledOnce();
  });

  describe('a user git action (ADR-0062)', () => {
    it.each([
      ['landing_branch_held', 409],
      ['confirm_stale', 409],
      ['stale', 409],
      ['not_checkout', 400],
      ['ordewell_branch', 400],
      ['pushed', 400],
      ['refused', 400],
      ['git_failed', 400],
    ] as const)('answers %s with %i, and logs nothing', async (code, status) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await answer(new UserGitError(code, 'no'));

      expect(res).toEqual({ status, body: { error: 'no', code } });
      expect(log).not.toHaveBeenCalled();
    });

    it('names the run holding the branch, and what changed since the person confirmed', async () => {
      const held = { sessionId: 's1', runId: 'r1', repo: 'api', branch: 'main' };
      expect((await answer(new UserGitError('landing_branch_held', 'held', { held }))).body).toMatchObject({ landingBranchHeld: held });
      const difference = { field: 'files', shown: ['a.ts'], now: ['a.ts', 'b.ts'] };
      expect((await answer(new UserGitError('confirm_stale', 'stale', { difference }))).body).toMatchObject({ confirmStale: difference });
    });
  });
});
