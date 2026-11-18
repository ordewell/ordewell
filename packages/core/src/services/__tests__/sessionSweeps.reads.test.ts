import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { getSessionsDir } from '../../utils/sessionDir';
import { saveSession } from '../../utils/sessionStore';
import { landingRuns } from '../landingInterlock';
import { createWorkspaceReader } from '../workspaceReader';

/*
 * A sweep that only reads every saved session (the landing interlock on a git
 * move, the owners on a branch listing) must not pay for working out whose a
 * pre-upgrade run is: that is an adopting host's question (ADR-0013). Counted
 * in file reads, not time: each session file is read once to list it and once
 * to load it, however many sessions there are.
 */

const reads = vi.hoisted(() => ({ byFile: new Map<string, number>() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (typeof args[0] === 'string') reads.byFile.set(args[0], (reads.byFile.get(args[0]) ?? 0) + 1);
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

const SESSIONS = 12;
/** Listing reads each file once and loading it once more. */
const READS_PER_FILE = 2;

describe('read-only sweeps over pre-upgrade sessions', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-sweep-')));
    for (let i = 0; i < SESSIONS; i++) saveSession(plan(`r${i}`), `goal ${i}`, workspace, `session-${String(i).padStart(4, '0')}abcdef`);
    // A file saved before runs named their session holds none.
    for (const file of sessionFiles()) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { plan: { isolation: { run: { session?: string } } } };
      delete data.plan.isolation.run.session;
      fs.writeFileSync(file, JSON.stringify(data));
    }
    reads.byFile.clear();
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  function sessionFiles(): string[] {
    const dir = getSessionsDir(workspace);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  }

  function plan(runId: string): LegacyPlanState {
    const run: IsolationRun = {
      id: runId,
      workspaceRoot: workspace,
      repos: [{ path: '.', root: workspace, baseRef: 'a1', baseBranch: 'main', integrationBranch: `ordewell/${runId}/integration` }],
      shared: [],
      sharedRepos: [],
      tasks: {},
    };
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'One', prompt: 'do it', assignedRunner: 'claude-code' })],
      generatedAt: '2026-01-01T00:00:00Z',
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: '2026-01-01T00:00:00Z',
      isolation: { run, resolvers: {} },
    } as LegacyPlanState;
  }

  const mostReads = () => Math.max(0, ...sessionFiles().map((f) => reads.byFile.get(f) ?? 0));

  it('reads each session file a constant number of times for the landing interlock', () => {
    const runs = landingRuns({ workspace, repo: '.', root: workspace }, () => false);

    expect(runs).toHaveLength(SESSIONS);
    expect(mostReads()).toBeLessThanOrEqual(READS_PER_FILE);
  });

  it.skipIf(!hasGit)('reads each session file a constant number of times for the owners of a branch listing', async () => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace, env: cleanEnv() });

    await createWorkspaceReader({ config: { workspaceRepos: [] } }).branches({ workspace });

    expect(mostReads()).toBeLessThanOrEqual(READS_PER_FILE);
  });
});
