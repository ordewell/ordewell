import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VerdictEngine } from '../VerdictEngine';
import { createTask, type Task, type Verdict } from '../../models/Task';
import { FakeRunnerSession, flushMicrotasks } from '../../testing';

const buildTask = (extra: Partial<Task> = {}): Task =>
  createTask({ id: 't1', title: 'do thing', taskMode: 'build', ...extra });

function fakeSession(initialOutput = '') {
  const session = new FakeRunnerSession();
  session.output = initialOutput;
  return Object.assign(session, {
    onOutput: vi.fn(session.onOutput.bind(session)),
    onExit: vi.fn(session.onExit.bind(session)),
    kill: vi.fn(session.kill.bind(session)),
    emit: session.emitOutput.bind(session),
    exit: session.emitExit.bind(session),
  });
}

describe('VerdictEngine', () => {
  describe('watch', () => {
    it('attaches to the session (registers onOutput and onExit callbacks)', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();
      engine.watch(buildTask(), session);

      expect(session.onOutput).toHaveBeenCalledTimes(1);
      expect(session.onExit).toHaveBeenCalledTimes(1);
    });

    it('fails a clean exit with no task_complete call', async () => {
      const engine = new VerdictEngine();
      const verdicts: { taskId: string; outcome: string }[] = [];
      engine.onVerdict((taskId, verdict) => verdicts.push({ taskId, outcome: verdict.outcome }));
      const session = fakeSession('all good');

      engine.watch(buildTask(), session);
      session.exit(0);
      await vi.waitFor(() => expect(verdicts).toHaveLength(1));

      expect(verdicts[0].outcome).toBe('fail');
      expect(verdicts[0].taskId).toBe('t1');
    });

    it('fails on a non-zero exit code', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string; reason: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome, reason: verdict.reason }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.exit(1);
      await vi.waitFor(() => expect(verdicts[0]?.outcome).toBe('fail'));

      expect(verdicts[0].reason).toMatch(/code 1/);
    });

    it('normalizes a null exit code to 0 but still requires a task_complete call', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.exit(null as unknown as number);
      await vi.waitFor(() => expect(verdicts[0]?.outcome).toBe('fail'));
    });

  });

  describe('the checkpoint tool (ADR-0022, V5)', () => {
    function watched() {
      const engine = new VerdictEngine();
      const raised: Array<{ taskId: string; summary: string }> = [];
      engine.onCheckpoint((taskId, summary) => raised.push({ taskId, summary }));
      const session = new FakeRunnerSession();
      const attempt = engine.watch(buildTask(), session);
      return { engine, raised, session, attempt };
    }

    it('raises a checkpoint event, and settles with continue on approve', async () => {
      const { engine, raised, session } = watched();

      const answer = session.callCheckpoint('  Drop the table?  ');
      expect(raised).toEqual([{ taskId: 't1', summary: 'Drop the table?' }]);

      engine.approveCheckpoint('t1');
      await expect(answer).resolves.toEqual({ kind: 'continue' });
      expect(session.written).toEqual([]);
    });

    it('settles with the reason on reject, writing nothing into the session', async () => {
      const { engine, session } = watched();

      const answer = session.callCheckpoint('Drop the table?');
      engine.rejectCheckpoint('t1', 'keep the data');

      await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'keep the data' });
      expect(session.written).toEqual([]);
    });

    it('is withdrawn when the attempt is cleared for a retry', async () => {
      const { engine, session } = watched();

      const answer = session.callCheckpoint('Drop the table?');
      engine.clear(buildTask());

      await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
    });

    it('is withdrawn when the verdict settles the attempt', async () => {
      const { engine, session, attempt } = watched();

      const answer = session.callCheckpoint('Drop the table?');
      engine.signalComplete('t1', attempt, { status: 'failed', summary: 'x', reason: 'gave up' });

      await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
    });

    it('is withdrawn when the verifier is reset', async () => {
      const { engine, session } = watched();

      const answer = session.callCheckpoint('Drop the table?');
      engine.reset();

      await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
    });

    it('refuses a call from an attempt that is no longer the task\'s current one', async () => {
      const { engine, raised, session } = watched();
      engine.watch(buildTask(), new FakeRunnerSession('s2'));

      await expect(session.callCheckpoint('late')).resolves.toMatchObject({ kind: 'withdrawn' });
      expect(raised).toEqual([]);
    });

    it('refuses a second call while one still waits, leaving the first to be answered', async () => {
      const { engine, raised, session } = watched();

      const first = session.callCheckpoint('first');
      await expect(session.callCheckpoint('second')).resolves.toMatchObject({ kind: 'withdrawn' });
      engine.approveCheckpoint('t1');

      await expect(first).resolves.toEqual({ kind: 'continue' });
      expect(raised).toHaveLength(1);
    });

    it('is withdrawn when its call goes away, telling the host nothing is left to answer', async () => {
      const { engine, session } = watched();
      const withdrawn: string[] = [];
      engine.onCheckpointWithdrawn((taskId) => withdrawn.push(taskId));
      const gone = new AbortController();

      const answer = session.callCheckpoint('Drop the table?', gone.signal);
      gone.abort();

      await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
      expect(withdrawn).toEqual(['t1']);
      engine.approveCheckpoint('t1');
      expect(session.written).toEqual([]);
    });

    it('asks again after a withdrawn call', async () => {
      const { engine, session } = watched();
      const gone = new AbortController();
      void session.callCheckpoint('first', gone.signal);
      gone.abort();

      const second = session.callCheckpoint('second');
      engine.approveCheckpoint('t1');

      await expect(second).resolves.toEqual({ kind: 'continue' });
    });

    it('approveCheckpoint is a no-op for unknown task', () => {
      const engine = new VerdictEngine();
      engine.approveCheckpoint('no-such-task');
    });

    it('rejectCheckpoint is a no-op for unknown task', () => {
      const engine = new VerdictEngine();
      engine.rejectCheckpoint('no-such-task', 'nope');
    });
  });

  describe('task_complete (ADR-0022)', () => {
    function watched() {
      const engine = new VerdictEngine();
      const verdicts: Array<{ taskId: string; verdict: Verdict }> = [];
      engine.onVerdict((taskId, verdict) => verdicts.push({ taskId, verdict }));
      const session = new FakeRunnerSession();
      const attempt = engine.watch(buildTask(), session);
      return { engine, verdicts, session, attempt };
    }

    it('passes on a done call, with the call named as the evidence', () => {
      const { verdicts, session } = watched();

      session.reportComplete({ status: 'done', summary: 'Added the endpoint.' });

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].taskId).toBe('t1');
      expect(verdicts[0].verdict.outcome).toBe('pass');
      expect(verdicts[0].verdict.checks.map((c) => [c.name, c.passed, c.skipped])).toEqual([
        ['task_complete', true, false],
      ]);
    });

    it('fails a blocked or failed call with the runner\'s reason', () => {
      for (const status of ['blocked', 'failed'] as const) {
        const { verdicts, session } = watched();

        session.reportComplete({ status, summary: 'Stopped early.', reason: 'the API key is missing' });

        expect(verdicts).toHaveLength(1);
        expect(verdicts[0].verdict.outcome).toBe('fail');
        expect(verdicts[0].verdict.reason).toContain(status);
        expect(verdicts[0].verdict.reason).toContain('the API key is missing');
      }
    });

    it('ignores a call for an attempt that is no longer the task\'s current one', () => {
      const { engine, verdicts, attempt } = watched();
      const next = engine.watch(buildTask(), new FakeRunnerSession('s2'));

      engine.signalComplete('t1', attempt, { status: 'done', summary: 'old' });
      expect(verdicts).toEqual([]);

      engine.signalComplete('t1', next, { status: 'done', summary: 'new' });
      expect(verdicts).toHaveLength(1);
    });

    it('ignores a call after the attempt was cleared', () => {
      const { engine, verdicts, session } = watched();
      engine.clear(buildTask());

      session.reportComplete({ status: 'done', summary: 'late' });

      expect(verdicts).toEqual([]);
    });

    it('gives one verdict when a second call follows the first, and none on the exit after', () => {
      const { verdicts, session } = watched();

      session.reportComplete({ status: 'blocked', summary: 'x', reason: 'needs a decision' });
      session.reportComplete({ status: 'done', summary: 'changed my mind' });
      session.emitExit(0);

      expect(verdicts.map((v) => v.verdict.outcome)).toEqual(['fail']);
    });

    it('fails an exit with no call, naming the missing call and the exit code', () => {
      const { verdicts, session } = watched();

      session.emitOutput('All done!\n');
      session.emitExit(0);

      expect(verdicts.map((v) => v.verdict.outcome)).toEqual(['fail']);
      expect(verdicts[0].verdict.reason).toContain('task_complete');
      expect(verdicts[0].verdict.checks.map((c) => [c.name, c.passed])).toEqual([
        ['task_complete', false],
        ['exit_code', true],
      ]);
    });

  });

  describe('markComplete', () => {
    it('produces a pass verdict bypassing evidence', () => {
      const engine = new VerdictEngine();
      const verdict = engine.markComplete(buildTask());

      expect(verdict.outcome).toBe('pass');
      expect(verdict.reason).toBe('Manually marked complete by user.');
      expect(verdict.checks).toEqual([
        { name: 'manual', passed: true, skipped: false, detail: 'Task was manually marked complete by the user; no automatic verification was performed.' },
      ]);
      expect(() => new Date(verdict.decidedAt)).not.toThrow();
    });

    it('a stale exit after markComplete adds no verdict to the call\'s', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));
      const session = new FakeRunnerSession();

      engine.watch(buildTask(), session);
      session.reportComplete({ status: 'done', summary: 'did it' });

      engine.markComplete(buildTask());
      session.emitExit(1);
      await flushMicrotasks();

      expect(verdicts).toEqual(['pass']);
    });
  });

  describe('clear', () => {
    it('a stale exit after clear adds no verdict to the call\'s', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));
      const session = new FakeRunnerSession();

      const task = buildTask();
      engine.watch(task, session);
      session.reportComplete({ status: 'done', summary: 'did it' });
      engine.clear(task);
      session.emitExit(1);
      await flushMicrotasks();

      expect(verdicts).toEqual(['pass']);
    });
    it('fresh watch after clear still delivers verdict', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));

      // First session — gets cleared (simulates retry)
      const session1 = fakeSession();
      const task = buildTask({ id: 't1' });
      engine.watch(task, session1);
      engine.clear(task);

      // Second session — fresh watch
      const session2 = new FakeRunnerSession('s2');
      engine.watch(task, session2);
      session2.reportComplete({ status: 'done', summary: 'did it' });
      session2.emitExit(0);
      await vi.waitFor(() => expect(verdicts).toHaveLength(1));

      expect(verdicts[0]).toBe('pass');
    });
  });

  describe('idle detection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets idleSince after 60s of no output on a running task', () => {
      const engine = new VerdictEngine();
      const idleEvents: { taskId: string; idleSince: string | null }[] = [];
      engine.onIdleChange((taskId, idleSince) => idleEvents.push({ taskId, idleSince }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('working...');
      expect(engine.getIdleSince('t1')).toBeNull();

      vi.advanceTimersByTime(60_000);

      expect(engine.getIdleSince('t1')).not.toBeNull();
      expect(idleEvents).toHaveLength(1);
      expect(idleEvents[0]).toEqual({ taskId: 't1', idleSince: engine.getIdleSince('t1') });
    });

    it('clears idleSince when output resumes', () => {
      const engine = new VerdictEngine();
      const idleEvents: (string | null)[] = [];
      engine.onIdleChange((_id, idleSince) => idleEvents.push(idleSince));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('working...');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();

      session.emit('more output');

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents[idleEvents.length - 1]).toBeNull();
    });

    it('leaves no stale timer firing after a retry (clear) once idleSince was set', () => {
      const engine = new VerdictEngine();
      const idleEvents: (string | null)[] = [];
      engine.onIdleChange((_id, idleSince) => idleEvents.push(idleSince));
      const session = fakeSession();
      const task = buildTask();

      engine.watch(task, session);
      session.emit('working...');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();

      engine.clear(task); // simulates retry
      expect(engine.getIdleSince('t1')).toBeNull();
      idleEvents.length = 0; // drop the teardown transition recorded by clear()

      vi.advanceTimersByTime(120_000); // well past another 60s window

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents).toHaveLength(0);
    });

    it('leaves no stale timer firing after a stop (reset) once idleSince was set', () => {
      const engine = new VerdictEngine();
      const idleEvents: (string | null)[] = [];
      engine.onIdleChange((_id, idleSince) => idleEvents.push(idleSince));
      const session = fakeSession();
      const task = buildTask();

      engine.watch(task, session);
      session.emit('working...');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();

      engine.reset(); // simulates stop
      expect(engine.getIdleSince('t1')).toBeNull();
      idleEvents.length = 0;

      vi.advanceTimersByTime(120_000);

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents).toHaveLength(0);
    });
  });

  describe('idle while the task waits on the user (ADR-0018, W1)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('still flags silence during a running structured turn', () => {
      const engine = new VerdictEngine();
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);

      session.emitOutput('› Bash(npm test)\n');
      vi.advanceTimersByTime(60_000);

      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('does not flag a paused task, and resumes watching when its next turn starts', () => {
      const engine = new VerdictEngine();
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');
      session.emitTurnEnd('completed');

      engine.pauseIdle('t1');
      vi.advanceTimersByTime(120_000);
      expect(engine.getIdleSince('t1')).toBeNull();

      session.sendMessage('carry on');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('clears an idle flag already raised when the task starts waiting', () => {
      const engine = new VerdictEngine();
      const idleEvents: (string | null)[] = [];
      engine.onIdleChange((_id, idleSince) => idleEvents.push(idleSince));
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');
      vi.advanceTimersByTime(60_000);

      engine.pauseIdle('t1');

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents.at(-1)).toBeNull();
    });

    it('keeps a checkpoint quiet until it is answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      void session.callCheckpoint('ok?');

      engine.pauseIdle('t1');
      vi.advanceTimersByTime(120_000);
      expect(engine.getIdleSince('t1')).toBeNull();

      engine.approveCheckpoint('t1');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();
    });
    it('does not flag a task waiting on a tool approval, and resumes once the last one is answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');

      session.requestPermission('p1', 'Bash', { command: 'npm test' });
      session.requestPermission('p2', 'Edit', { file_path: 'a.ts' });
      vi.advanceTimersByTime(120_000);
      expect(engine.getIdleSince('t1')).toBeNull();

      session.answerPermission('p1', { decision: 'allow' });
      vi.advanceTimersByTime(120_000);
      expect(engine.getIdleSince('t1')).toBeNull();

      session.withdrawPermission('p2');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('clears an idle flag already raised when a tool approval is asked', () => {
      const engine = new VerdictEngine();
      const idleEvents: (string | null)[] = [];
      engine.onIdleChange((_id, idleSince) => idleEvents.push(idleSince));
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');
      vi.advanceTimersByTime(60_000);

      session.requestPermission('p1', 'Bash', { command: 'npm test' });

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents.at(-1)).toBeNull();
    });

    it('keeps watching through a request the task mode already answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');

      session.emitEvent({ type: 'permission_request', id: 'p1', name: 'Read', detail: '{}', decided: { decision: 'allow' } });
      vi.advanceTimersByTime(60_000);

      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('stays quiet while a checkpoint still waits, though an approval was answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeRunnerSession();
      engine.watch(buildTask(), session);
      session.requestPermission('p1', 'Bash', { command: 'npm test' });
      engine.pauseIdle('t1');

      session.answerPermission('p1', { decision: 'allow' });
      vi.advanceTimersByTime(120_000);

      expect(engine.getIdleSince('t1')).toBeNull();
    });
  });

  describe('reset', () => {
    it('a stale exit after reset adds no verdict to the call\'s', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));

      const sessionA = new FakeRunnerSession('sa', 'a');
      engine.watch(buildTask({ id: 'a' }), sessionA);
      sessionA.reportComplete({ status: 'done', summary: 'did it' });

      engine.reset();

      sessionA.emitExit(1);
      await flushMicrotasks();

      expect(verdicts).toEqual(['pass']);
    });
    // stop/loadPlan reset the engine before the old session is gone, so a
    // session from before the reset can still speak after the task's next watch.
    it('a session from before the reset cannot decide the next attempt of the same task', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));
      const before = new FakeRunnerSession('s1');
      const after = new FakeRunnerSession('s2');

      engine.watch(buildTask(), before);
      engine.reset();
      engine.watch(buildTask(), after);
      before.reportComplete({ status: 'done', summary: 'old' });
      before.emitExit(1);
      await flushMicrotasks();

      expect(verdicts).toEqual([]);
      after.reportComplete({ status: 'done', summary: 'new' });
      expect(verdicts).toEqual(['pass']);
    });
  });
});
