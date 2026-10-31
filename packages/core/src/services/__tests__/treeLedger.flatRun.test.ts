import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState, Task } from '../../models/Task';
import { FakeWorktreeIsolation } from '../../testing';
import { deleteSession, saveSession } from '../../utils/sessionStore';
import { treeEventLogFile } from '../../utils/treeEventLog';
import type { Session, SessionDeps } from '../createSession';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { fakeConfig, makeSession, memoryTaskLogs } from './sessionTestKit';
import { heldPlanner, NOW, plan, prose, recordingRunner, settled, task, until } from './supervisorTestKit';

/**
 * What "a flat run has no ledger, no log and no change in behaviour" means
 * (ADR-0056 M5, ADR-0058 S3): for each Parallel limit and delegation setting,
 * what a plan starts, in what order, on the real session store, with each
 * attempt and planner call reporting more than any budget here. Every answer is
 * written out; none is worked out by the code under test. Delegation on is still
 * a flat run: only a carve makes a tree.
 */

const HUGE = 50_000_000;

interface Row {
  name: string;
  delegationTokens: number;
  parallel: number;
  tasks: readonly string[];
  /** Running once the run has started. */
  running: readonly string[];
  /** Started by the time the first has passed. */
  afterOne: readonly string[];
  /** Started by the end, each passed in turn. */
  order: readonly string[];
}

const ROWS: readonly Row[] = [
  { name: 'delegation off, one at a time', delegationTokens: 0, parallel: 1, tasks: ['a', 'b', 'c'], running: ['a'], afterOne: ['a', 'b'], order: ['a', 'b', 'c'] },
  { name: 'delegation off, two at a time', delegationTokens: 0, parallel: 2, tasks: ['a', 'b', 'c'], running: ['a', 'b'], afterOne: ['a', 'b', 'c'], order: ['a', 'b', 'c'] },
  { name: 'delegation off, room for all', delegationTokens: 0, parallel: 8, tasks: ['a', 'b', 'c'], running: ['a', 'b', 'c'], afterOne: ['a', 'b', 'c'], order: ['a', 'b', 'c'] },
  { name: 'delegation on with a tiny budget, one at a time', delegationTokens: 1, parallel: 1, tasks: ['a', 'b', 'c'], running: ['a'], afterOne: ['a', 'b'], order: ['a', 'b', 'c'] },
  { name: 'delegation on with a tiny budget, two at a time', delegationTokens: 1, parallel: 2, tasks: ['a', 'b', 'c'], running: ['a', 'b'], afterOne: ['a', 'b', 'c'], order: ['a', 'b', 'c'] },
  { name: 'delegation on with a large budget, room for all', delegationTokens: 1_000_000_000, parallel: 8, tasks: ['a', 'b', 'c'], running: ['a', 'b', 'c'], afterOne: ['a', 'b', 'c'], order: ['a', 'b', 'c'] },
];

let workspace: string;
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-flat-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' }).map((entry) => path.join(dir, entry));

function open(delegationTokens: number, parallel: number, tasks: Task[], eventLog?: SessionDeps['eventLog']) {
  const runs = recordingRunner();
  const planner = heldPlanner();
  const session: Session = makeSession({
    config: fakeConfig({ maxParallelSessions: parallel, worktreeIsolation: true }),
    isolation: new FakeWorktreeIsolation(),
    runner: runs.runner,
    aiService: planner.aiService,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const, delegationTokens } }),
    workspaceRoot: () => workspace,
    sessionId: 'flat-session',
    saveSession: (state, goal, dir, id) => { saveSession(state, goal, dir, id); },
    openTaskLog: memoryTaskLogs(),
    ...(eventLog ? { eventLog } : {}),
  });
  session.loadPlan(plan(tasks) as LegacyPlanState, 'a flat goal', workspace);
  return { session, runs, planner };
}

describe.each(ROWS)('a flat run: $name', ({ delegationTokens, parallel, tasks, running, afterOne, order }) => {
  it('starts what it always started, in that order, whatever its runners spend', async () => {
    const { session, runs } = open(delegationTokens, parallel, tasks.map((id, i) => task(id, i + 1)));
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => runs.spawnedIds().length === running.length);
    await settled();
    expect(runs.spawnedIds()).toEqual(running);

    for (const id of runs.spawnedIds()) runs.of(id).emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: HUGE, outputTokens: HUGE } });
    await settled();
    expect(session.outOfBudget).toBeNull();

    runs.of('a').reportComplete({ status: 'done', summary: 'Done.' });
    await until(() => runs.spawnedIds().length === afterOne.length);
    await settled();
    expect(runs.spawnedIds()).toEqual(afterOne);

    for (const id of order) {
      if (id === 'a') continue;
      await until(() => runs.spawnedIds().includes(id));
      runs.of(id).reportComplete({ status: 'done', summary: 'Done.' });
      await settled();
    }
    expect(runs.spawnedIds()).toEqual(order);
  });

  it('opens no ledger and asks for no log, through a run and a planner turn', async () => {
    const eventLog = vi.fn(() => { throw new Error('a flat run has no log'); });
    const { session, runs, planner } = open(delegationTokens, parallel, tasks.map((id, i) => task(id, i + 1)), eventLog);
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => runs.spawnedIds().length === running.length);

    const turn = session.continueConversation('how is it going?').catch(() => undefined);
    await until(() => planner.calls.length === 1);
    planner.calls[0].progress?.({ type: 'usage', record: { source: 'claude-code', inputTokens: HUGE } });
    planner.calls[0].finish(prose('Fine.'));
    await turn;
    await settled();

    expect(eventLog).not.toHaveBeenCalled();
    expect(session.outOfBudget).toBeNull();
  });

  it('writes no event log to disk', async () => {
    const { session, runs } = open(delegationTokens, parallel, tasks.map((id, i) => task(id, i + 1)));
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => runs.spawnedIds().length === running.length);
    runs.of('a').emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: HUGE } });
    runs.of('a').reportComplete({ status: 'done', summary: 'Done.' });
    await settled();
    session.destroy();
    await settled();

    const files = filesUnder(path.join(workspace, '.ordewell'));
    expect(files.filter((f) => f.endsWith('.json'))).not.toEqual([]);
    expect(files.filter((f) => f.endsWith('.jsonl'))).toEqual([]);
  });

  it('seats nothing with a budget: a placement carries one only from a carve', async () => {
    const { session, runs } = open(delegationTokens, parallel, tasks.map((id, i) => task(id, i + 1)));
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => runs.spawnedIds().length === running.length);
    expect(session.hostChild('a').budget).toBeUndefined();
  });
});

describe('the control: what a flat run lacks is there once a carve makes a tree', () => {
  it('writes the log where a tree keeps it, and it goes with the root', async () => {
    const { session, runs } = open(1_000_000, 2, [task('a', 1)]);
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => runs.spawnedIds().includes('a'));
    await session.execute({ command: 'stop_task', task: 'a' }, { kind: 'user' });
    await settled();

    const carved = await session.carveChild('a', { tokens: 500_000 });
    expect(carved.ok).toBe(true);
    await (await session.ledger()).flushed();

    const log = treeEventLogFile('flat-session', workspace);
    const lines = fs.readFileSync(log, 'utf-8').trimEnd().split('\n').map((line) => JSON.parse(line) as { kind: string; node: string }[]);
    expect(lines.flat().map(({ kind, node }) => [kind, node])).toEqual([['node_opened', 'root'], ['node_opened', 'root/1']]);
    expect(session.hostChild('a').budget?.path).toBe('root/1');

    session.destroy();
    await settled();
    deleteSession('flat-session', workspace);
    expect(fs.existsSync(log)).toBe(false);
  });
});
