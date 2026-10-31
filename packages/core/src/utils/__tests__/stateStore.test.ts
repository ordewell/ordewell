import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadState, saveState } from '../stateStore';
import { createTask, type LegacyPlanState } from '../../models/Task';

describe('loadState', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-state-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('brings an ADR-0013 isolation record to the repo-group shape', () => {
    fs.mkdirSync(path.join(tmpDir, '.ordewell'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.ordewell', 'state.json'), JSON.stringify({
      tasks: [], runners: ['claude-code'], status: 'approved', generatedAt: '', lastUpdated: '',
      isolation: {
        run: { id: 'r1', workspaceRoot: '/work/app', baseRef: 'abc', integrationBranch: 'ordewell/r1/integration', tasks: {} },
        resolvers: { r: 'c' },
      },
    }));

    expect(loadState(tmpDir)!.plan.isolation).toEqual({
      run: {
        id: 'r1', workspaceRoot: '/work/app', shared: [], sharedRepos: [], tasks: {},
        repos: [{ path: '.', root: '/work/app', baseRef: 'abc', integrationBranch: 'ordewell/r1/integration' }],
      },
      resolvers: { r: 'c' },
    });
  });

  const plan = (): LegacyPlanState => ({ tasks: [], runners: ['claude-code'], status: 'approved', generatedAt: '', lastUpdated: '' });

  it('fails a task saved in progress, a subtask too: nothing is running it now', () => {
    const running = createTask({ id: 't2', title: 'Child', status: 'in_progress', attempted: true });
    const parent = createTask({ id: 't1', title: 'Parent', status: 'in_progress', subtasks: [running] });
    saveState({ tasks: [parent, createTask({ id: 't3', title: 'Other', status: 'approved' })], runners: ['claude-code'], status: 'approved', generatedAt: '', lastUpdated: '' }, tmpDir);

    const { tasks } = loadState(tmpDir)!.plan;

    const reason = 'It was interrupted when Ordewell stopped, and nothing is running it now.';
    expect(tasks[0]).toMatchObject({ status: 'failed', verdict: { outcome: 'fail', reason, checks: [] } });
    expect(tasks[0].subtasks[0]).toMatchObject({ status: 'failed', attempted: true, verdict: { outcome: 'fail', reason } });
    expect(tasks[1].status).toBe('approved');
    expect(tasks[1].verdict).toBeUndefined();
  });

  it('gives back the session id the state was saved for, kept off the plan', () => {
    saveState(plan(), tmpDir, '2026-10-18T10-05-18_review_0328b893');

    const saved = loadState(tmpDir)!;
    expect(saved.sessionId).toBe('2026-10-18T10-05-18_review_0328b893');
    expect(saved.plan).not.toHaveProperty('sessionId');
  });

  it('still loads a state file saved without a session id', () => {
    fs.mkdirSync(path.join(tmpDir, '.ordewell'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.ordewell', 'state.json'), JSON.stringify(plan()));

    const saved = loadState(tmpDir)!;
    expect(saved.sessionId).toBeUndefined();
    expect(saved.plan.status).toBe('approved');
  });

  it('replaces the state file whole on every save, so a crash mid-write cannot empty it', () => {
    const statePath = path.join(tmpDir, '.ordewell', 'state.json');
    saveState(plan(), tmpDir);
    const before = fs.statSync(statePath).ino;

    saveState({ ...plan(), status: 'running' }, tmpDir);

    // A write in place truncates first; a rename swaps the file in one step.
    expect(fs.statSync(statePath).ino).not.toBe(before);
    expect(fs.readdirSync(path.dirname(statePath))).toEqual(['state.json']);
    expect(loadState(tmpDir)!.plan.status).toBe('running');
  });
});
