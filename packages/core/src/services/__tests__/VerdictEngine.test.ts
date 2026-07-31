import { describe, it, expect, vi } from 'vitest';
import { VerdictEngine } from '../VerdictEngine';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask, type Task } from '../../models/Task';

const buildTask = (extra: Partial<Task> = {}): Task =>
  createTask({ id: 't1', title: 'do thing', taskMode: 'build', completionMarker: 'mk-1', ...extra });

/** A controllable fake session: captures the onOutput/onExit callbacks so a test
 *  can drive them, and records kill/write calls. Mirrors ITerminalSession's shape. */
function fakeSession(initialOutput = '') {
  let output = initialOutput;
  let onOutputCb: ((text: string) => void) | undefined;
  let onExitCb: ((code: number) => void) | undefined;
  const writeLog: string[] = [];
  return {
    id: 's1',
    taskId: 't1',
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
      const verdicts: { taskId: string; outcome: string; output: string }[] = [];
      engine.onVerdict((taskId, verdict, output) => verdicts.push({ taskId, outcome: verdict.outcome, output }));
      const session = fakeSession('all good');

      engine.watch(buildTask(), session);
      session.exit(0);
      await new Promise(r => setTimeout(r, 10));

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].outcome).toBe('fail');
      expect(verdicts[0].output).toBe('all good');
      expect(verdicts[0].taskId).toBe('t1');
    });

    it('fails on a non-zero exit code', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string; reason: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome, reason: verdict.reason }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.exit(1);
      await new Promise(r => setTimeout(r, 10));

      expect(verdicts[0].outcome).toBe('fail');
      expect(verdicts[0].reason).toMatch(/code 1/);
    });

    it('normalizes a null exit code to 0 but still requires the completion marker', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.exit(null as unknown as number);
      await new Promise(r => setTimeout(r, 10));

      expect(verdicts[0].outcome).toBe('fail');
    });

    it('detects the completion marker mid-stream and passes regardless of exit code', async () => {
      const engine = new VerdictEngine();
      const verdicts: { outcome: string; reason: string }[] = [];
      engine.onVerdict((_id, verdict) => verdicts.push({ outcome: verdict.outcome, reason: verdict.reason }));
      const session = fakeSession();

      engine.watch(buildTask(), session);
      session.emit('working...\n<<<ORDEWELL_DONE_mk-1>>>\ndone');

      session.exit(137);
      await new Promise(r => setTimeout(r, 10));

      expect(verdicts[0].outcome).toBe('pass');
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

    it('delivers the session output to listeners (not its internal marker buffer)', async () => {
      const engine = new VerdictEngine();
      let deliveredOutput = '';
      engine.onVerdict((_id, _verdict, output) => { deliveredOutput = output; });
      const session = fakeSession('captured-by-session');

      engine.watch(buildTask(), session);
      session.exit(0);
      await new Promise(r => setTimeout(r, 10));

      expect(deliveredOutput).toBe('captured-by-session');
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
      session.emit(composeAugmentedPrompt(task, [task], { tddEnabled: true }));

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

    it('approveCheckpoint writes ORDEWELL_CONTINUE to session stdin', () => {
      const engine = new VerdictEngine();
      const session = fakeSession();
      engine.watch(buildTask(), session);
      session.emit('<<<ORDEWELL_CHECKPOINT: need approval>>>');

      engine.approveCheckpoint('t1');

      const log = (session as unknown as { _writeLog: string[] })._writeLog;
      expect(log.some((s: string) => s.includes('ORDEWELL_CONTINUE'))).toBe(true);
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
      await new Promise(r => setTimeout(r, 10));

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
      await new Promise(r => setTimeout(r, 10));

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
      await new Promise(r => setTimeout(r, 10));

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toBe('pass');
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
      await new Promise(r => setTimeout(r, 10));

      expect(verdicts).toHaveLength(1);            // one from onOutput, none from stale exit
      expect(verdicts[0]).toBe('pass');
    });
  });
});
