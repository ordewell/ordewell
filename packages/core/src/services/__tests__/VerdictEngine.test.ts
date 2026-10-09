import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VerdictEngine } from '../VerdictEngine';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask, type Task, type Verdict } from '../../models/Task';
import { FakeStructuredSession, flushMicrotasks } from '../../testing';

const buildTask = (extra: Partial<Task> = {}): Task =>
  createTask({ id: 't1', title: 'do thing', taskMode: 'build', completionMarker: 'mk-1', ...extra });

/** A controllable fake session: captures the onOutput/onExit callbacks so a test
 *  can drive them, and records kill/write calls. Mirrors ITerminalSession's shape. */
function fakeSession(initialOutput = '', interactive = false) {
  let output = initialOutput;
  let onOutputCb: ((text: string) => void) | undefined;
  let onExitCb: ((code: number) => void) | undefined;
  const writeLog: string[] = [];
  return {
    id: 's1',
    taskId: 't1',
    interactive,
    onOutput: vi.fn((cb: (text: string) => void) => { onOutputCb = cb; }),
    onExit: vi.fn((cb: (code: number) => void) => { onExitCb = cb; }),
    kill: vi.fn(),
    getOutput: vi.fn(() => output),
    write: vi.fn((text: string) => { writeLog.push(text); }),
    emit(text: string) { output += text; onOutputCb?.(text); },
    exit(code: number) { onExitCb?.(code); },
    get onOutputCb() { return onOutputCb; },
    get onExitCb() { return onExitCb; },
    get _writeLog() { return writeLog; },
  };
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

    it('does not pass on a clean exit until the completion marker was emitted', async () => {
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

    it('normalizes a null exit code to 0 but still requires the completion marker', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.exit(null as unknown as number);
      await vi.waitFor(() => expect(verdicts[0]?.outcome).toBe('fail'));
    });

    it('detects the completion marker mid-stream and passes regardless of exit code', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string; reason: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome, reason: verdict.reason }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('working...\n<<<ORDEWELL_DONE_mk-1>>>\ndone');

      session.exit(137);
      await vi.waitFor(() => expect(verdicts[0]?.outcome).toBe('pass'));

      expect(verdicts[0].reason).toMatch(/completion marker/);
    });

    it('detects a marker split across multiple output chunks', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('working <<<ORDEWELL_DONE_mk');
      expect(session.kill).not.toHaveBeenCalled();
      session.emit('-1>>>done');
    });

    it('does not kill when no marker appears', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('just normal output, no marker');

      expect(session.kill).not.toHaveBeenCalled();
    });

    it('detects a marker soft-wrapped by a TUI (newlines + ANSI escapes inside the token)', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      // What a real PTY stream looks like when the TUI wraps the marker at
      // terminal width and repaints with colors/cursor movements.
      session.emit('\x1b[2K\x1b[1G  <<<ORDEWELL_DO\x1b[0m\r\n\x1b[38;5;245mNE_mk\r\n  -1>>\x1b[0m>\r\n');
    });

    it('detects a marker wrapped inside a bordered TUI pane (box-drawing gutter)', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('│ <<<ORDEWELL_DONE_\r\n│ mk-1>>> │\r\n');
    });

    it('detects an OpenCode TUI marker assembled by cursor-positioned repaints', () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push(verdict.outcome));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      // Captured from OpenCode 1.18.4: the answer is painted in three writes
      // on row 9, while an unrelated spinner repaint on row 23 arrives between
      // the marker fragments in the raw PTY stream.
      session.emit(
        '\x1b[9;6H<<<ORDEW\x1b[0m'
        + '\x1b[23;4H⬝⬝⬝⬝⬝⬝⬝⬝\x1b[0m'
        + '\x1b[9;14HELL_DONE_mk-\x1b[0m'
        + '\x1b[19;6H\x1b[9;26H1>>>\x1b[0m',
      );

      expect(verdicts).toEqual(['pass']);
    });

    it('is NOT triggered by the TUI echoing the split-marker prompt instruction', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      // The prompt instruction renders the marker in two halves; echoing it
      // (even wrapped) must not complete the task.
      session.emit('print one final line: `<<<ORDEWELL_` immediately followed\r\nby `DONE_mk-1>>>` joined into a single unbroken token');

      expect(session.kill).not.toHaveBeenCalled();
    });
  });

  describe('the checkpoint tool (ADR-0022, V5)', () => {
    function watched() {
      const engine = new VerdictEngine();
      const raised: Array<{ taskId: string; summary: string }> = [];
      engine.onCheckpoint((taskId, summary) => raised.push({ taskId, summary }));
      const session = new FakeStructuredSession();
      const attempt = engine.watch(buildTask(), session);
      return { engine, raised, session, attempt };
    }

    it('raises the same checkpoint event as the marker, and settles with continue on approve', async () => {
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
      engine.watch(buildTask(), new FakeStructuredSession('s2'));

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

    it('leaves the marker path writing its answer into the session', () => {
      const engine = new VerdictEngine();
      const session = new FakeStructuredSession();
      engine.watch(buildTask(), session);

      session.emitOutput('<<<ORDEWELL_CHECKPOINT: need review>>>');
      engine.approveCheckpoint('t1');

      expect(session.written.join('')).toContain('ORDEWELL_CONTINUE');
    });
  });

  describe('checkpoint markers', () => {
    it('detects a checkpoint marker and emits event without killing the session', async () => {
      const engine = new VerdictEngine();
      const checkpoints: { taskId: string; summary: string }[] = [];
      engine.onCheckpoint((taskId, summary) => checkpoints.push({ taskId, summary }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: about to delete the database>>>');

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].taskId).toBe('t1');
      expect(checkpoints[0].summary).toBe('about to delete the database');
      expect(session.kill).not.toHaveBeenCalled();
    });

    it('detects a checkpoint marker with extra whitespace', async () => {
      const engine = new VerdictEngine();
      const checkpoints: { summary: string }[] = [];
      engine.onCheckpoint((_id, summary) => checkpoints.push({ summary }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT:   padded summary   >>>');

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].summary).toBe('padded summary');
    });

    it('handles multiple checkpoints in the same task', async () => {
      const engine = new VerdictEngine();
      const summaries: string[] = [];
      engine.onCheckpoint((_id, summary) => summaries.push(summary));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('before\n<<<ORDEWELL_CHECKPOINT: first decision>>>\nmiddle\n<<<ORDEWELL_CHECKPOINT: second decision>>>\nafter');

      expect(summaries).toEqual(['first decision', 'second decision']);
    });

    it('does not re-emit the same checkpoint when new output arrives', async () => {
      const engine = new VerdictEngine();
      const summaries: string[] = [];
      engine.onCheckpoint((_id, summary) => summaries.push(summary));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: decision one>>>');
      expect(summaries).toEqual(['decision one']);
      session.emit(' more output');
      expect(summaries).toEqual(['decision one']);
    });

    // The runner echoes the prompt it was handed. When that prompt carried a
    // literal checkpoint token, every HITL task left `in_progress` for
    // `awaiting_user` the moment its session started — a running task painted as
    // one waiting on the user.
    it('does not checkpoint on the runner echoing its own HITL prompt', () => {
      const engine = new VerdictEngine();
      const summaries: string[] = [];
      engine.onCheckpoint((_id, summary) => summaries.push(summary));
      const session = fakeSession();
      const task = buildTask({ prompt: 'ship it', sliceType: 'HITL' });

      engine.watch(task, session);
      session.emit(composeAugmentedPrompt(task, [task]));

      expect(summaries).toEqual([]);
    });

    it('detects a checkpoint marker split across output chunks', async () => {
      const engine = new VerdictEngine();
      const checkpoints: { summary: string }[] = [];
      engine.onCheckpoint((_id, summary) => checkpoints.push({ summary }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('text <<<ORDEWELL_CHECKPOINT: spl');
      expect(checkpoints).toHaveLength(0);
      session.emit('it across chunks>>> more');

      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].summary).toBe('split across chunks');
    });

    it('assembles a checkpoint whose opening, summary and closing arrive in separate chunks', () => {
      const engine = new VerdictEngine();
      const summaries: string[] = [];
      engine.onCheckpoint((_id, summary) => summaries.push(summary));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('log line\n<<<ORDEW');
      session.emit('ELL_CHECKPOINT: drop the ');
      session.emit('legacy table?');
      session.emit('>');
      session.emit('>> waiting');
      session.emit(' <<<ORDEWELL_CHECKPOINT: second>>>');

      expect(summaries).toEqual(['drop the legacy table?', 'second']);
    });

    it('does not bridge an abandoned checkpoint opening to a closing far downstream', () => {
      const engine = new VerdictEngine();
      const summaries: string[] = [];
      engine.onCheckpoint((_id, summary) => summaries.push(summary));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: ');
      for (let i = 0; i < 200; i++) session.emit(`${'build output '.repeat(40)}\n`);
      session.emit('arrow -> >>> end');

      expect(summaries).toEqual([]);
    });

    it('approveCheckpoint writes ORDEWELL_CONTINUE to session stdin', () => {
      const engine = new VerdictEngine();
      const session = fakeSession();
      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.approveCheckpoint('t1');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log.some((s: string) => s.includes('ORDEWELL_CONTINUE'))).toBe(true);
    });

    it('submits the resume token with Enter on an interactive session', () => {
      // The VS Code terminal and tmux run a raw-mode TUI: a `\n` types the
      // token into the composer but never sends it, so the agent stays paused.
      const engine = new VerdictEngine();
      const session = fakeSession('', true);
      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.approveCheckpoint('t1');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log).toContain('ORDEWELL_CONTINUE\r');
    });

    it('rejects an interactive session with the reason and an Enter keystroke', () => {
      const engine = new VerdictEngine();
      const session = fakeSession('', true);
      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.rejectCheckpoint('t1', 'not the right approach');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log).toContain('ORDEWELL_REJECT: not the right approach\r');
    });

    it('keeps the newline terminator for a line-oriented headless session', () => {
      const engine = new VerdictEngine();
      const session = fakeSession();
      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.approveCheckpoint('t1');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log).toContain('\nORDEWELL_CONTINUE\n');
    });

    it('rejectCheckpoint writes ORDEWELL_REJECT with reason to session stdin', () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.rejectCheckpoint('t1', 'not the right approach');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log.some((s: string) => s.includes('ORDEWELL_REJECT: not the right approach'))).toBe(true);
    });

    it('rejectCheckpoint uses a default reason when none provided', () => {
      const engine = new VerdictEngine();
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.rejectCheckpoint('t1', '');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log.some((s: string) => s.includes('ORDEWELL_REJECT'))).toBe(true);
    });

    it('approveCheckpoint is a no-op for unknown task', () => {
      const engine = new VerdictEngine();
      // does not throw
      engine.approveCheckpoint('no-such-task');
    });

    it('rejectCheckpoint is a no-op for unknown task', () => {
      const engine = new VerdictEngine();
      engine.rejectCheckpoint('no-such-task', 'nope');
    });

    it('clears checkpoint state on clear()', async () => {
      const engine = new VerdictEngine();
      const session = fakeSession();
      const task = buildTask();
      engine.watch(task, session);
      session.emit('<<<ORDEWELL_CHECKPOINT: test>>>');
      engine.clear(task);
      // approve should be no-op after clear
      engine.approveCheckpoint('t1');
      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log.some((s: string) => s.includes('ORDEWELL_CONTINUE'))).toBe(false);
    });
  });

  describe('task_complete (ADR-0022)', () => {
    function watched() {
      const engine = new VerdictEngine();
      const verdicts: Array<{ taskId: string; verdict: Verdict }> = [];
      engine.onVerdict((taskId, verdict) => verdicts.push({ taskId, verdict }));
      const session = new FakeStructuredSession();
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
        ['completion_marker', true, true],
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
      const next = engine.watch(buildTask(), new FakeStructuredSession('s2'));

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

    it('gives one verdict when the marker comes first and the call after it', () => {
      const { verdicts, session } = watched();

      session.emitOutput('<<<ORDEWELL_DONE_mk-1>>>\n');
      session.reportComplete({ status: 'failed', summary: 'x', reason: 'second thoughts' });
      session.emitExit(1);

      expect(verdicts.map((v) => v.verdict.outcome)).toEqual(['pass']);
      expect(verdicts[0].verdict.checks[0].name).toBe('completion_marker');
    });

    it('gives one verdict when the call comes first and the marker after it', () => {
      const { verdicts, session } = watched();

      session.reportComplete({ status: 'blocked', summary: 'x', reason: 'needs a decision' });
      session.emitOutput('<<<ORDEWELL_DONE_mk-1>>>\n');
      session.emitExit(0);

      expect(verdicts.map((v) => v.verdict.outcome)).toEqual(['fail']);
      expect(verdicts[0].verdict.checks[0].name).toBe('task_complete');
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

    it('delivers verdict from onOutput on marker, stale exit after markComplete adds none', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_DONE_mk-1>>>');   // marker seen — verdict delivered from onOutput

      engine.markComplete(buildTask());           // manual override — no-op (already delivered)
      session.exit(1);                             // stale exit — ignored (generation bumped)
      await flushMicrotasks();

      expect(verdicts).toHaveLength(1);            // one from onOutput, none from stale exit
      expect(verdicts[0]).toBe('pass');
    });
  });

  describe('clear', () => {
    it('delivers verdict from onOutput on marker, stale exit after clear adds none', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));
      const session = fakeSession();

      const task = buildTask();
      engine.watch(task, session);
      session.emit('<<<ORDEWELL_DONE_mk-1>>>');   // marker seen — verdict delivered from onOutput
      engine.clear(task);                          // bumps gen (no-op, already delivered)
      session.exit(1);                              // stale exit — ignored
      await flushMicrotasks();

      expect(verdicts).toHaveLength(1);            // one from onOutput, none from stale exit
      expect(verdicts[0]).toBe('pass');
    });

    it('fresh watch after clear still delivers verdict', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));

      // First session — gets cleared (simulates retry)
      const session1 = fakeSession();
      const task = buildTask({ id: 't1', completionMarker: 'mk-1' });
      engine.watch(task, session1);
      engine.clear(task);

      // Second session — fresh watch
      const session2 = fakeSession();
      engine.watch(task, session2);
      session2.emit('<<<ORDEWELL_DONE_mk-1>>>');
      session2.exit(0);
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
      const session = new FakeStructuredSession();
      engine.watch(buildTask(), session);

      session.emitOutput('› Bash(npm test)\n');
      vi.advanceTimersByTime(60_000);

      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('does not flag a paused task, and resumes watching when its next turn starts', () => {
      const engine = new VerdictEngine();
      const session = new FakeStructuredSession();
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
      const session = new FakeStructuredSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');
      vi.advanceTimersByTime(60_000);

      engine.pauseIdle('t1');

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents.at(-1)).toBeNull();
    });

    it('keeps a terminal checkpoint quiet until it is answered', () => {
      const engine = new VerdictEngine();
      const session = fakeSession();
      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: ok?>>>');

      engine.pauseIdle('t1');
      vi.advanceTimersByTime(120_000);
      expect(engine.getIdleSince('t1')).toBeNull();

      engine.approveCheckpoint('t1');
      vi.advanceTimersByTime(60_000);
      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('does not flag a task waiting on a tool approval, and resumes once the last one is answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeStructuredSession();
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
      const session = new FakeStructuredSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');
      vi.advanceTimersByTime(60_000);

      session.requestPermission('p1', 'Bash', { command: 'npm test' });

      expect(engine.getIdleSince('t1')).toBeNull();
      expect(idleEvents.at(-1)).toBeNull();
    });

    it('keeps watching through a request the task mode already answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeStructuredSession();
      engine.watch(buildTask(), session);
      session.emitOutput('working\n');

      session.emitEvent({ type: 'permission_request', id: 'p1', name: 'Read', detail: '{}', decided: { decision: 'allow' } });
      vi.advanceTimersByTime(60_000);

      expect(engine.getIdleSince('t1')).not.toBeNull();
    });

    it('stays quiet while a checkpoint still waits, though an approval was answered', () => {
      const engine = new VerdictEngine();
      const session = new FakeStructuredSession();
      engine.watch(buildTask(), session);
      session.requestPermission('p1', 'Bash', { command: 'npm test' });
      engine.pauseIdle('t1');

      session.answerPermission('p1', { decision: 'allow' });
      vi.advanceTimersByTime(120_000);

      expect(engine.getIdleSince('t1')).toBeNull();
    });
  });

  describe('reset', () => {
    it('delivers verdict from onOutput on marker, stale exit after reset adds none', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));

      const sessionA = fakeSession();
      engine.watch(buildTask({ id: 'a', completionMarker: 'mk-a' }), sessionA);
      sessionA.emit('<<<ORDEWELL_DONE_mk-a>>>');   // marker seen — verdict delivered from onOutput

      engine.reset();                              // clears all generations

      sessionA.exit(1);                             // stale exit — ignored (gen cleared)
      await flushMicrotasks();

      expect(verdicts).toHaveLength(1);            // one from onOutput, none from stale exit
      expect(verdicts[0]).toBe('pass');
    });

    // stop/loadPlan reset the engine without killing every terminal (a VS Code
    // terminal stays open; a tmux exit lands on the next poll), so a session
    // from before the reset can still speak after the task's next watch.
    it('a session from before the reset cannot decide the next attempt of the same task', async () => {
      const engine = new VerdictEngine();
      const verdicts: string[] = [];
      engine.onVerdict((_id, v) => verdicts.push(v.outcome));
      const before = fakeSession();
      const after = fakeSession();

      engine.watch(buildTask(), before);
      engine.reset();
      engine.watch(buildTask(), after);
      before.emit('<<<ORDEWELL_DONE_mk-1>>>');
      before.exit(1);
      await flushMicrotasks();

      expect(verdicts).toEqual([]);
      after.emit('<<<ORDEWELL_DONE_mk-1>>>');
      expect(verdicts).toEqual(['pass']);
    });
  });
});
