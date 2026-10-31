import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskOrchestrator, TaskControlError } from '../TaskOrchestrator';
import { ScriptRunner } from '../ScriptRunner';
import { createTask, type Task } from '../../models/Task';
import type { IRunner, ScriptExit } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { endedByExit } from '../VerdictEngine';
import type { WorkspaceEnv } from '../workspaceEnv';
import type { StoredHandoff } from '../../models/Handoff';

/**
 * A script task in the scheduler (ADR-0035): an ops task in everything about
 * where and when it runs (ADR-0020), whose verdict is its exit status.
 */

function recording() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, null);
    sessions.push(session);
    return session;
  });
  const runner = { spawn, stop: vi.fn(async () => {}), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
  return { runner, sessions, spawn };
}

const env: WorkspaceEnv = { env: { ORDEWELL_TEST: 'workspace' }, blockedEnvrc: null, refused: [], trackedEnvFile: null };

function setup(isolation = new FakeWorktreeIsolation()) {
  const agents = recording();
  const scripts = recording();
  const notifications = fakeNotification();
  const handoffs: Array<{ sessionId: string | undefined; taskId: string; handoff: StoredHandoff }> = [];
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications,
    runner: agents.runner,
    scriptRunner: scripts.runner,
    output: new BufferedTaskOutputSource(),
    recordHandoff: (sessionId, taskId, handoff) => { handoffs.push({ sessionId, taskId, handoff }); },
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => env,
  });
  const notices: string[] = [];
  orchestrator.subscribe({ onIsolationNotice: ({ message }) => notices.push(message) });
  const spawned = (taskId: string) => [...agents.spawn.mock.calls, ...scripts.spawn.mock.calls].filter(([o]) => o.taskId === taskId).map(([o]) => o);
  const latest = (taskId: string) => [...agents.sessions, ...scripts.sessions].filter((s) => s.taskId === taskId).at(-1)!;
  const end = (taskId: string, exit: ScriptExit, durationMs = 1200) => {
    // The session emits each step's exit before it hands the end on.
    latest(taskId).emitEvent({ type: 'script_exit', durationMs, code: exit.outcome === 'passed' ? 0 : 1, signal: null });
    latest(taskId).reportScriptExit(exit);
    latest(taskId).emitExit(exit.outcome === 'passed' ? 0 : 1);
  };
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  return { orchestrator, isolation, agents, scripts, spawned, latest, end, status, notices, notifications, handoffs };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });
const script = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Script ${id}`, type: 'script', commands: [['git', 'push', 'origin', 'main']], ...over });

const PASSED: ScriptExit = { outcome: 'passed' };

describe('TaskOrchestrator: script tasks (ADR-0035)', () => {
  it('runs its body at the workspace root through the script runner, with the workspace\'s variables and no runner of its own', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1, { timeoutMs: 30_000 })]);

    await e.orchestrator.approveReview();

    expect(e.agents.spawn).not.toHaveBeenCalled();
    expect(e.scripts.spawn).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 's1', runner: 'script', cwd: '/repo', env: env.env,
      script: { commands: [['git', 'push', 'origin', 'main']], timeoutMs: 30_000 },
    }));
    expect(e.isolation.calls.map((c) => c.op)).not.toContain('startRun');
    expect(e.orchestrator.getAttempt('s1')?.runner).toBe('script');
  });

  it('passes on its exit status, through VerdictEngine, with a script_exit check and no usage ledger', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();

    e.end('s1', PASSED);

    await vi.waitFor(() => expect(e.status('s1')).toBe('completed'));
    const task = e.orchestrator.storeInstance.get('s1')!;
    expect(task.verdict).toMatchObject({ outcome: 'pass', checks: [{ name: 'script_exit', passed: true }] });
    expect(task.attemptUsage).toBeUndefined();
  });

  it('hands over a passing script as its exit and how long it took, with the output as the report (ADR-0047)', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();
    e.latest('s1').emitOutput('Everything up-to-date\n');

    e.end('s1', PASSED, 1200);

    await vi.waitFor(() => expect(e.status('s1')).toBe('completed'));
    const expected = { summary: 'exited 0 in 1.2 s\nEverything up-to-date', findings: [], findingCount: 0, report: 'Everything up-to-date', attempt: 1 };
    expect(e.orchestrator.storeInstance.get('s1')!.handoff).toEqual({ summary: 'exited 0 in 1.2 s\nEverything up-to-date', findings: [], findingCount: 0, attempt: 1 });
    expect(e.handoffs).toEqual([{ sessionId: e.latest('s1').id, taskId: 's1', handoff: expected }]);
  });

  it('hands over a passing script that printed nothing as a summary alone', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();

    e.end('s1', PASSED, 300);

    await vi.waitFor(() => expect(e.status('s1')).toBe('completed'));
    expect(e.handoffs.map((h) => h.handoff)).toEqual([{ summary: 'exited 0 in 0.3 s', findings: [], findingCount: 0, attempt: 1 }]);
  });

  it('hands over a failed script as its exit code and the end of its output without inferred findings', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();
    e.latest('s1').emitOutput('To origin\n ! [rejected] main -> main (non-fast-forward)\n');

    e.end('s1', { outcome: 'failed', command: 'git push origin main', status: { code: 1, signal: null }, errorTail: 'rejected' }, 800);

    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));
    const output = 'To origin\n ! [rejected] main -> main (non-fast-forward)';
    const digest = { summary: `exited 1 in 0.8 s\n${output}`, findings: [], findingCount: 0, attempt: 1 };
    expect(e.handoffs.map((h) => h.handoff)).toEqual([{ ...digest, report: output }]);
    expect(e.orchestrator.storeInstance.get('s1')!.handoff).toEqual(digest);
  });

  it('hands over a script its time limit ended as timed out, and one a signal ended by the signal', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1), script('s2', 2)]);
    await e.orchestrator.approveReview();

    e.end('s1', { outcome: 'timed-out', command: 'git push origin main', timeoutMs: 600_000, errorTail: '' }, 600_100);
    e.end('s2', { outcome: 'failed', status: { code: null, signal: 'SIGKILL' }, errorTail: '' }, 2000);

    await vi.waitFor(() => expect(e.handoffs).toHaveLength(2));
    const [timedOut, killed] = e.handoffs.map((h) => h.handoff);
    expect(timedOut).toEqual({ summary: 'timed out in 600.1 s', findings: [], findingCount: 0, attempt: 1 });
    expect(killed).toEqual({ summary: 'ended by SIGKILL in 2 s', findings: [], findingCount: 0, attempt: 1 });
  });

  it('hands over nothing for a script that was stopped, and clears the one before it', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();
    e.end('s1', { outcome: 'failed', status: { code: 2, signal: null }, errorTail: '' });
    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));
    await e.orchestrator.retryTask('s1');
    await vi.waitFor(() => expect(e.spawned('s1')).toHaveLength(2));

    e.end('s1', { outcome: 'stopped' });

    await vi.waitFor(() => expect(e.orchestrator.storeInstance.get('s1')!.verdict?.reason).toContain('did not finish'));
    expect(e.handoffs).toHaveLength(1);
    expect(e.orchestrator.storeInstance.get('s1')!.handoff).toBeUndefined();
  });

  it('fails with the status and the tail of the error output, and never reads limit words as a usage-limit pause', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();
    const limitWords = "You've hit your usage limit · resets 8:10pm";
    e.latest('s1').emitOutput(`${limitWords}\n`);

    e.end('s1', { outcome: 'failed', command: 'git push origin main', status: { code: 1, signal: null }, errorTail: limitWords });

    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));
    const task = e.orchestrator.storeInstance.get('s1')!;
    expect(task.awaitingReason).toBeUndefined();
    expect(task.resumeAt).toBeUndefined();
    expect(endedByExit(task.verdict!)).toBe(false);
    expect(task.verdict!.checks).toEqual([expect.objectContaining({ name: 'script_exit', passed: false })]);
    expect(task.verdict!.reason).toBe(`The script failed: \`git push origin main\` exited with code 1.\n\nThe end of its error output:\n${limitWords}`);
  });

  it('says in the verdict where the whole output is, and names the file as an artifact of the handoff', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();
    const file = '/repo/.ordewell/sessions/s/tasks/s1/1.output.txt';

    e.end('s1', { outcome: 'failed', command: 'npm run ci', status: { code: 1, signal: null }, errorTail: 'Test failed', fullOutput: { file, droppedChars: 0 } });

    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));
    expect(e.orchestrator.storeInstance.get('s1')!.verdict!.reason).toBe(`The script failed: \`npm run ci\` exited with code 1.\n\nThe end of its error output:\nTest failed\n\nAll of its output is in ${file}`);
    expect(e.handoffs.at(-1)!.handoff.artifacts).toEqual([{ kind: 'file', path: file }]);
    expect(e.orchestrator.storeInstance.get('s1')!.handoff!.artifacts).toEqual([{ kind: 'file', path: file }]);
  });

  it('says how much of the output a hard cap did not keep', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();

    e.end('s1', { outcome: 'timed-out', command: 'make', timeoutMs: 600_000, errorTail: '', fullOutput: { file: '/out.txt', droppedChars: 1234 } });

    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));
    expect(e.orchestrator.storeInstance.get('s1')!.verdict!.reason).toContain('All of its output is in /out.txt, except its last 1234 characters, which were not saved.');
  });

  it('fails a script its time limit ended, saying so', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();

    e.end('s1', { outcome: 'timed-out', command: 'git push origin main', timeoutMs: 600_000, errorTail: '' });

    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));
    expect(e.orchestrator.storeInstance.get('s1')!.verdict!.reason).toBe('The script failed: the time limit of 10 minutes ran out while `git push origin main` ran, so it was ended.');
  });

  it('runs its body again as written on a retry, told nothing of the attempt before', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();
    e.latest('s1').emitOutput('rejected: non-fast-forward\n');
    e.end('s1', { outcome: 'failed', command: 'git push origin main', status: { code: 1, signal: null }, errorTail: 'rejected' });
    await vi.waitFor(() => expect(e.status('s1')).toBe('failed'));

    await e.orchestrator.retryTask('s1');

    await vi.waitFor(() => expect(e.spawned('s1')).toHaveLength(2));
    expect(e.spawned('s1').map((o) => [o.prompt, o.script])).toEqual([
      ['', { commands: [['git', 'push', 'origin', 'main']], timeoutMs: 600_000 }],
      ['', { commands: [['git', 'push', 'origin', 'main']], timeoutMs: 600_000 }],
    ]);
  });

  it('starts by force like any task the user starts', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);

    await e.orchestrator.forceStartTask('s1');

    expect(e.spawned('s1')).toHaveLength(1);
  });

  it('takes no message and no interrupt: it runs no model', async () => {
    const e = setup();
    e.orchestrator.loadPlan([script('s1', 1)]);
    await e.orchestrator.approveReview();

    expect(() => e.orchestrator.sendTaskMessage('s1', 'also tag it')).toThrow(TaskControlError);
    await expect(e.orchestrator.interruptTask('s1')).rejects.toThrow(/script task: it runs no model/);
  });

  describe('Stop', () => {
    it('stops a script task\'s run through the script runner, and it is back to not started', async () => {
      const e = setup();
      e.orchestrator.loadPlan([script('s1', 1)]);
      await e.orchestrator.approveReview();
      const session = e.latest('s1');

      await e.orchestrator.cancelTask('s1');

      expect(e.scripts.runner.stop).toHaveBeenCalledWith(session.id);
      expect(e.agents.runner.stop).not.toHaveBeenCalled();
      expect(e.status('s1')).toBe('pending');
    });

    it('stops every script with the run', async () => {
      const e = setup();
      e.orchestrator.loadPlan([script('s1', 1)]);
      await e.orchestrator.approveReview();

      e.orchestrator.stop();

      expect(e.scripts.runner.stopAll).toHaveBeenCalled();
      expect(e.scripts.runner.stop).toHaveBeenCalledWith(e.latest('s1').id);
      expect(e.status('s1')).toBe('pending');
    });
  });

  describe('as an ops task (ADR-0020)', () => {
    async function gated() {
      const e = setup();
      e.orchestrator.loadPlan([change('t1', 1), script('s2', 2, { dependencies: ['t1'] })]);
      await e.orchestrator.approveReview();
      e.latest('t1').reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(e.status('t1')).toBe('completed'));
      await flushMicrotasks();
      return e;
    }

    it('waits at a closed merge gate, and starts once Merge all opens it', async () => {
      const e = await gated();

      expect(e.spawned('s2')).toHaveLength(0);
      expect(e.orchestrator.getMergeGate('s2')).toEqual(['t1']);
      expect(e.notices).toContainEqual(expect.stringContaining('Waiting for Merge all: "Script s2"'));

      expect(await e.orchestrator.mergeRun()).toEqual({ outcome: 'merged' });

      await vi.waitFor(() => expect(e.spawned('s2')[0]?.cwd).toBe('/repo'));
    });

    it('never runs while a Merge all is under way', async () => {
      const e = await gated();
      let spawnedDuringMerge = -1;
      let refused: unknown = null;
      e.isolation.mergeIntoCheckedOut = async (run) => {
        for (const record of Object.values(run.tasks)) e.isolation.mergedByHand.add(record.taskId);
        await e.orchestrator.tick();
        refused = await e.orchestrator.forceStartTask('s2').then(() => null, (err: unknown) => err);
        spawnedDuringMerge = e.spawned('s2').length;
        return { outcome: 'merged' };
      };

      await e.orchestrator.mergeRun();

      expect(spawnedDuringMerge).toBe(0);
      expect(refused).toBeInstanceOf(TaskControlError);
      await vi.waitFor(() => expect(e.spawned('s2')).toHaveLength(1));
    });

    it('keeps Merge all out while it runs', async () => {
      const e = setup();
      const t1 = change('t1', 1);
      e.orchestrator.loadPlan([t1, script('s2', 2)]);
      await e.orchestrator.approveReview();
      e.latest('t1').reportComplete({ status: 'done', summary: '' });
      await vi.waitFor(() => expect(e.status('t1')).toBe('completed'));

      await expect(e.orchestrator.mergeRun()).rejects.toThrow('Ops task "Script s2" is running in your checkout');
      expect(e.isolation.calls.map((c) => c.op)).not.toContain('mergeIntoCheckedOut');
    });

    it('waits on the user when it leaves a tracked change, rather than completing', async () => {
      const e = setup();
      e.orchestrator.loadPlan([change('t1', 1), script('s2', 2)]);
      await e.orchestrator.approveReview();
      e.isolation.changedFiles = ['package.json'];

      e.end('s2', PASSED);

      await vi.waitFor(() => expect(e.status('s2')).toBe('awaiting_user'));
      expect(e.orchestrator.storeInstance.get('s2')!.awaitingReason).toBe('files-changed');
      expect(e.notices).toContainEqual(expect.stringContaining('changed tracked files in your checkout: package.json'));
    });
  });
});

describe('TaskOrchestrator: a script task run for real', () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function real() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-script-run-'));
    workspaces.push(root);
    const scriptRunner = new ScriptRunner();
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(),
      notifications: fakeNotification(),
      runner: recording().runner,
      scriptRunner,
      output: new BufferedTaskOutputSource(),
      workspaceRoot: () => root,
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    });
    return { root, scriptRunner, orchestrator, task: (id: string) => orchestrator.storeInstance.get(id)! };
  }

  const node = (code: string) => [process.execPath, '-e', code];

  it('completes a body every step of which exits 0, its output in the task\'s handoff report', async () => {
    const r = real();
    r.orchestrator.loadPlan([script('s1', 1, { commands: [node("console.log('pushed main')")] })]);

    await r.orchestrator.approveReview();

    await vi.waitFor(() => expect(r.task('s1').status).toBe('completed'));
    expect(r.task('s1').verdict!.checks.map((c) => c.name)).toEqual(['script_exit']);
    expect(r.task('s1').handoff?.summary).toContain('pushed main');
    expect(r.task('s1').handoff).toMatchObject({ summary: expect.stringMatching(/^exited 0 in \d/), findingCount: 0 });
  });

  it('fails a script that exits otherwise, with the end of its error output in the reason', async () => {
    const r = real();
    r.orchestrator.loadPlan([script('s1', 1, { commands: undefined, script: 'echo "permission denied" >&2\nexit 7' })]);

    await r.orchestrator.approveReview();

    await vi.waitFor(() => expect(r.task('s1').status).toBe('failed'));
    expect(r.task('s1').verdict!.reason).toBe('The script failed: it exited with code 7.\n\nThe end of its error output:\npermission denied');
  });

  it('kills the running step on Stop, and the task is back to not started', async () => {
    const r = real();
    r.orchestrator.loadPlan([script('s1', 1, { commands: [node("setTimeout(() => require('fs').writeFileSync('late', ''), 1500)")] })]);
    await r.orchestrator.approveReview();
    await vi.waitFor(() => expect(r.scriptRunner.activeCount).toBe(1));

    await r.orchestrator.cancelTask('s1');

    await vi.waitFor(() => expect(r.scriptRunner.activeCount).toBe(0));
    expect(r.task('s1').status).toBe('pending');
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(fs.existsSync(path.join(r.root, 'late'))).toBe(false);
  }, 15_000);
});
