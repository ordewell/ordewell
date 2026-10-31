import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import type { ExecutionRecord } from '../../models/Execution';
import {
  attemptShape, identicalRetry, noEdits, oscillatingEdit, recordEdit, retryLimit, wakeUpRateTripped,
  SupervisionMemory,
  type EditMemory,
} from '../LoopGuards';

const t3 = { id: 't3', ref: '#3', title: 'Build' };

const task = (id: string, over: Partial<Task> = {}): Task =>
  createTask({ id, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet' }, ...over });

describe('the retry limit', () => {
  it('lets a retry through below the limit', () => {
    expect(retryLimit(t3, 0, 2)).toBeNull();
    expect(retryLimit(t3, 1, 2)).toBeNull();
  });

  it('refuses the retry past it, and escalates the task to the user', () => {
    const trip = retryLimit(t3, 2, 2)!;

    expect(trip.key).toBe('retry-limit:t3');
    expect(trip.refusal).toBe('Refused by the retry limit: you have retried task #3 "Build" 2 times this run, the most your settings allow. It is escalated to the user now: tell them what you tried, and do not retry it again.');
    expect(trip.escalation).toBe('Loop guard, retry limit: I retried task #3 "Build" 2 times this run, the most your settings allow, and stopped. It needs you: retry it, change it or skip it.');
  });

  it('counts a limit of one in the singular', () => {
    expect(retryLimit(t3, 1, 1)!.refusal).toContain('retried task #3 "Build" once this run');
  });
});

describe('no identical retry', () => {
  it('refuses a retry after a failure with the same prompt and model', () => {
    const failed = attemptShape(task('t3'));

    const trip = identicalRetry(t3, failed, attemptShape(task('t3')))!;

    expect(trip.key).toBe('identical-retry:t3');
    expect(trip.refusal).toBe('Refused: task #3 "Build" failed with this same prompt and model, and an unchanged retry would fail the same way. Change something or escalate: edit its prompt with edit_plan, or move it to another model or runner, then retry; or tell the user.');
    expect(trip.escalation).toMatch(/^Loop guard, identical retry: I tried to retry task #3 "Build" unchanged after it failed/);
  });

  it.each([
    ['its prompt', { prompt: 'do t3, and run the migrations first' }],
    ['its model', { assignedModel: { modelId: 'opus', modelLabel: 'Opus' } }],
    ['its thinking effort', { assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'high' } }],
    ['its runner', { assignedRunner: 'codex' as const }],
    ['its skills', { skills: ['tdd'] }],
  ])('lets a retry through once %s changed', (_what, change) => {
    expect(identicalRetry(t3, attemptShape(task('t3')), attemptShape(task('t3', change)))).toBeNull();
  });

  it('has nothing to compare before a failure', () => {
    expect(identicalRetry(t3, undefined, attemptShape(task('t3')))).toBeNull();
  });

  it('reads the same model whichever order its fields come in', () => {
    const before = attemptShape(task('t3', { assignedModel: { modelLabel: 'Sonnet', modelId: 'sonnet' } }));
    expect(identicalRetry(t3, before, attemptShape(task('t3')))).not.toBeNull();
  });

  describe('of a script task, whose body is read as a prompt is (ADR-0035)', () => {
    const script = (over: Partial<Task> = {}): Task =>
      createTask({ id: 't3', title: 'Push', type: 'script', commands: [['git', 'push', 'origin', 'main']], ...over });

    it('refuses a retry of the same body and time limit, saying what to change', () => {
      const trip = identicalRetry(t3, attemptShape(script()), attemptShape(script()))!;

      expect(trip.refusal).toBe('Refused: task #3 "Build" failed with this same body and time limit, and an unchanged retry would run the same commands. Change something or escalate: edit its "commands", "script" or "timeoutMs" with edit_plan, then retry; or tell the user.');
    });

    it.each([
      ['its commands', { commands: [['git', 'push', '--force-with-lease', 'origin', 'main']] }],
      ['its body\'s kind', { commands: undefined, script: 'git push origin main' }],
      ['its time limit', { timeoutMs: 1_200_000 }],
    ])('lets a retry through once %s changed', (_what, change) => {
      expect(identicalRetry(t3, attemptShape(script()), attemptShape(script(change)))).toBeNull();
    });

    it('reads a limit left out as the ten minutes it means', () => {
      expect(identicalRetry(t3, attemptShape(script()), attemptShape(script({ timeoutMs: 600_000 })))).not.toBeNull();
    });
  });
});

describe('no oscillating edits', () => {
  const plan = [task('t1'), task('t2', { title: 'Write the docs', prompt: 'document the API' })];

  it('refuses re-adding a task removed earlier this run, by its title or its prompt', () => {
    const memory = recordEdit(noEdits(), plan, [plan[0]]);

    const byTitle = oscillatingEdit(memory, [plan[0]], [plan[0], task('n1', { title: 'write the docs ', prompt: 'something new' })]);
    const byPrompt = oscillatingEdit(memory, [plan[0]], [plan[0], task('n2', { title: 'Docs', prompt: 'document the API' })]);

    expect(byTitle!.key).toBe('re-add:write the docs');
    expect(byTitle!.refusal).toBe('Edit refused: it re-adds "write the docs", which you removed earlier this run. Re-adding what you removed is going round in circles; nothing was changed. Escalate to the user instead.');
    expect(byTitle!.escalation).toBe('Loop guard, oscillating edits: I tried to re-add "write the docs", which I removed earlier this run, and stopped. It needs you to decide whether that task belongs in the plan.');
    expect(byPrompt).not.toBeNull();
  });

  it('refuses changing a field back to what it was before its own earlier edit', () => {
    const edited = plan.map((t) => (t.id === 't2' ? { ...t, assignedRunner: 'codex' as const } : t));
    const memory = recordEdit(noEdits(), plan, edited);

    const trip = oscillatingEdit(memory, edited, plan);

    expect(trip!.key).toBe('revert:t2:assignedRunner');
    expect(trip!.refusal).toBe('Edit refused: it changes the assignedRunner of "Write the docs" back to what it was before your own earlier edit. Undoing your own edits is going round in circles; nothing was changed. Escalate to the user instead.');
    expect(trip!.escalation).toMatch(/^Loop guard, oscillating edits: I tried to undo my own earlier change to the assignedRunner of "Write the docs"/);
  });

  it('lets a field move on to a third value, and other tasks change freely', () => {
    const edited = plan.map((t) => (t.id === 't2' ? { ...t, prompt: 'document the API, v2' } : t));
    const memory = recordEdit(noEdits(), plan, edited);

    const onward = edited.map((t) => (t.id === 't2' ? { ...t, prompt: 'document the API, v3' } : t));
    const other = edited.map((t) => (t.id === 't1' ? { ...t, prompt: 'do t1 again' } : t));

    expect(oscillatingEdit(memory, edited, onward)).toBeNull();
    expect(oscillatingEdit(memory, edited, other)).toBeNull();
  });

  it('remembers nothing it did not do', () => {
    const memory: EditMemory = noEdits();
    expect(oscillatingEdit(memory, [plan[0]], plan)).toBeNull();
  });

  it('refuses re-arming a skipped task: whether it runs again is the user\'s', () => {
    const skipped = [task('t1', { status: 'skipped' })];

    const trip = oscillatingEdit(noEdits(), skipped, [task('t1', { status: 'pending' })]);

    expect(trip!.key).toBe('un-skip:t1');
    expect(trip!.refusal).toBe('Edit refused: it puts "Task t1" back to run, which was skipped. Whether a skipped task runs again is the user\'s to decide; nothing was changed. Tell them if it should.');
    expect(oscillatingEdit(noEdits(), skipped, [task('t1', { status: 'skipped', prompt: 'do t1 better' })])).toBeNull();
  });
});

describe('the memory round-trips through a snapshot', () => {
  const plan = [task('t1'), task('t2', { title: 'Write the docs', prompt: 'document the API' })];

  it('keeps the retries, the failed attempts, the edits and what the user was told', () => {
    const memory = new SupervisionMemory();
    memory.done(
      { command: 'retry_task', actor: 'supervisor', task: { id: 't1', ref: '#1', title: 'Task t1' }, outcome: 'done', at: '2026-10-11T18:00:00Z' },
      plan,
    );
    memory.settled({ ...plan[0], status: 'failed' });
    memory.edited(plan, [plan[0]]);
    const trip = retryLimit(t3, 2, 2)!;
    memory.firstReport(trip);

    const restored = new SupervisionMemory();
    restored.restore(memory.snapshot());

    const target = { task: { ...plan[0], status: 'failed' as const }, ref: '#1' };
    expect(restored.check({ command: 'retry_task', task: 't1', from: 'fresh' }, target, plan, 1)?.key).toBe('retry-limit:t1');
    expect(restored.check({ command: 'run_task', task: 't1' }, target, plan, 5)?.key).toBe('identical-retry:t1');
    expect(restored.checkEdit([plan[0]], [plan[0], task('n1', { title: 'write the docs ', prompt: 'something new' })])?.key).toBe('re-add:write the docs');
    expect(restored.firstReport(trip)).toBe(false);
  });

  it('restores nothing from a plan saved before the snapshot existed', () => {
    const memory = new SupervisionMemory();
    memory.done(
      { command: 'retry_task', actor: 'supervisor', task: { id: 't1', ref: '#1', title: 'Task t1' }, outcome: 'done', at: '2026-10-11T18:00:00Z' },
      plan,
    );

    memory.restore(undefined);

    expect(memory.snapshot()).toEqual({ retries: {}, skips: {}, failedWith: {}, edits: noEdits(), told: [] });
  });
});

describe('the wake-up rate', () => {
  const minute = 60_000;
  const rate = { max: 3, windowMs: 10 * minute };

  it('trips past the most wake-ups the window allows', () => {
    expect(wakeUpRateTripped([0, minute, 2 * minute], 2 * minute, rate)).toBe(false);
    expect(wakeUpRateTripped([0, minute, 2 * minute, 3 * minute], 3 * minute, rate)).toBe(true);
  });

  it('forgets wake-ups older than the window', () => {
    expect(wakeUpRateTripped([0, minute, 12 * minute, 13 * minute], 13 * minute, rate)).toBe(false);
  });
});

describe('a task the user stopped (ADR-0029)', () => {
  const stopped = createTask({ id: 't1', order: 1, title: 'Build', prompt: 'do it', assignedRunner: 'claude-code' });
  const target = { task: stopped, ref: '#1' };
  const record = (command: ExecutionRecord['command'], actor: ExecutionRecord['actor']): ExecutionRecord => ({ command, actor, task: { id: 't1', ref: '#1', title: 'Build' }, outcome: 'done', at: '2026-10-31T10:00:00Z' });

  it('refuses a start of it through a save, and lets it through once the user starts it', () => {
    const memory = new SupervisionMemory();
    memory.stopped('t1');
    const reloaded = new SupervisionMemory();
    reloaded.restore(memory.snapshot());

    expect(reloaded.check({ command: 'retry_task', task: 't1', from: 'fresh' }, target, [stopped], 2)?.key).toBe('user-stopped:t1');
    expect(reloaded.check({ command: 'run_task', task: 't1' }, target, [stopped], 2)?.key).toBe('user-stopped:t1');
    expect(reloaded.allStopped(['t1'])).toBe(true);
    expect(reloaded.allStopped(['t1', 't2'])).toBe(false);
    expect(reloaded.allStopped([])).toBe(false);

    reloaded.done(record('retry_task', 'supervisor'), [stopped]);
    expect(reloaded.allStopped(['t1'])).toBe(true);
    reloaded.done(record('retry_task', 'user'), [stopped]);
    expect(reloaded.check({ command: 'run_task', task: 't1' }, target, [stopped], 2)).toBeNull();
  });
});
