import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type LegacyPlanState, type TaskStatus } from '../../models/Task';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { saveSession } from '../../utils/sessionStore';
import { interlock, landingRuns, savedRunLooksLive, type LandingMove, type LandingRun } from '../landingInterlock';

const run = (over: Partial<LandingRun> = {}): LandingRun => ({
  sessionId: 's1', runId: 'r1', repo: 'api', branch: 'main', live: true, unmerged: true, ...over,
});

const held = { sessionId: 's1', runId: 'r1', repo: 'api', branch: 'main' };
const switchAway: LandingMove = { kind: 'switch', repo: 'api', from: 'main', to: 'feature' };
const detach: LandingMove = { kind: 'switch', repo: 'api', from: 'main', to: null };
const remove: LandingMove = { kind: 'delete', repo: 'api', branch: 'main' };

describe('interlock (ADR-0062 G7)', () => {
  it.each<[string, LandingRun[], LandingMove, ReturnType<typeof interlock>]>([
    ['a switch away under a live run', [run()], switchAway, { held, warnings: [] }],
    ['a detach under a live run', [run()], detach, { held, warnings: [] }],
    ['a delete under a live run', [run()], remove, { held, warnings: [] }],
    ['a switch once settled with unmerged work', [run({ live: false })], switchAway, { held: null, warnings: [expect.stringContaining('Merge all') as unknown as string] }],
    ['a delete once settled with unmerged work', [run({ live: false })], remove, { held: null, warnings: [expect.stringContaining('Merge all') as unknown as string] }],
    ['a switch once settled with nothing landed', [run({ live: false, unmerged: false })], switchAway, { held: null, warnings: [] }],
    ['a switch in another repository', [run({ repo: 'web' })], switchAway, { held: null, warnings: [] }],
    ['a switch from another branch', [run({ branch: 'develop' })], switchAway, { held: null, warnings: [] }],
    ['a switch onto the landing branch', [run()], { kind: 'switch', repo: 'api', from: 'feature', to: 'main' }, { held: null, warnings: [] }],
    ['a switch to the branch it is on', [run()], { kind: 'switch', repo: 'api', from: 'main', to: 'main' }, { held: null, warnings: [] }],
    ['a delete of another branch', [run()], { kind: 'delete', repo: 'api', branch: 'feature' }, { held: null, warnings: [] }],
    ['no open run', [], switchAway, { held: null, warnings: [] }],
  ])('%s', (_name, runs, move, expected) => {
    expect(interlock(runs, move)).toEqual(expected);
  });

  it('names the live run when a settled one shares the branch', () => {
    const answer = interlock([run({ runId: 'old', live: false }), run({ sessionId: 's2', runId: 'r2' })], switchAway);
    expect(answer.held).toEqual({ sessionId: 's2', runId: 'r2', repo: 'api', branch: 'main' });
  });
});

describe('landing runs from saved sessions (ADR-0062 G7)', () => {
  let workspace: string;

  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-landing-')); });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  function isolationRun(id: string, over: Partial<IsolationRun> = {}): IsolationRun {
    return {
      id,
      workspaceRoot: workspace,
      repos: [
        { path: 'api', root: path.join(workspace, 'api'), baseRef: 'a1', baseBranch: 'main', integrationBranch: `ordewell/${id}/api` },
        { path: 'web', root: path.join(workspace, 'web'), baseRef: 'b1', startedDetached: true, integrationBranch: `ordewell/${id}/web` },
      ],
      shared: [],
      sharedRepos: [],
      tasks: {},
      ...over,
    };
  }

  function plan(run: IsolationRun | undefined, status: TaskStatus = 'pending'): LegacyPlanState {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'One', prompt: 'do it', assignedRunner: 'claude-code', status })],
      generatedAt: '2026-01-01T00:00:00Z',
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: '2026-01-01T00:00:00Z',
      ...(run ? { isolation: { run, resolvers: {} } } : {}),
    } as LegacyPlanState;
  }

  it('names each branch a run lands on, skips a detached start, and asks the host whether it is live', () => {
    saveSession(plan(isolationRun('r1', { landings: { t1: { api: ['c1'] } } })), 'goal', workspace, 's1');
    saveSession(plan(undefined), 'goal', workspace, 's2');
    const asked: string[] = [];

    const runs = landingRuns(workspace, (sessionId) => { asked.push(sessionId); return true; });

    expect(runs).toEqual([{ sessionId: 's1', runId: 'r1', repo: 'api', branch: 'main', live: true, unmerged: true }]);
    expect(asked).toEqual(['s1']);
  });

  it('reads a run with nothing landed as holding no unmerged work', () => {
    saveSession(plan(isolationRun('r1')), 'goal', workspace, 's1');
    expect(landingRuns(workspace, () => false)).toEqual([{ sessionId: 's1', runId: 'r1', repo: 'api', branch: 'main', live: false, unmerged: false }]);
  });

  it('judges a saved run live by an attempt in progress or a landing under way', () => {
    expect(savedRunLooksLive(plan(isolationRun('r1'), 'in_progress'))).toBe(true);
    expect(savedRunLooksLive(plan(isolationRun('r1', { landing: { taskId: 't1', tips: {} } })))).toBe(true);
    expect(savedRunLooksLive(plan(isolationRun('r1'), 'completed'))).toBe(false);
    expect(savedRunLooksLive(plan(undefined, 'in_progress'))).toBe(false);
  });
});
