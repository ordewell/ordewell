import { describe, it, expect } from 'vitest';
import { createWakePolicy, type RunEvent } from '../WakePolicy';

const DEBOUNCE = 1000;

function event(kind: RunEvent['kind'], at: number, taskId?: string): RunEvent {
  return { kind, at, taskId };
}

describe('createWakePolicy', () => {
  it('never wakes for passes alone, however long it waits', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_passed', 10, 't2'));

    expect(policy.poll(1_000_000)).toBeNull();
  });

  it.each(['task_failed', 'waiting_input', 'waiting_approval', 'task_idle', 'landing_conflict'] as const)(
    'wakes for %s',
    (kind) => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event(kind, 0, 't1'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([event(kind, 0, 't1')]);
    },
  );

  describe('debounce window', () => {
    it('merges attention events inside the window into one wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('waiting_input', 300, 't2'));
      policy.push(event('landing_conflict', 900, 't3'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        event('task_failed', 0, 't1'),
        event('waiting_input', 300, 't2'),
        event('landing_conflict', 900, 't3'),
      ]);
    });

    it('wakes once the window has fully elapsed, and a pass does not open it', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('task_failed', 400, 't2'));

      expect(policy.poll(400 + DEBOUNCE - 1)).toBeNull();
      expect(policy.poll(400 + DEBOUNCE)).not.toBeNull();
    });

    it('runs the window from the first attention event, so a steady stream cannot hold the wake-up off', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('task_failed', 600, 't2'));

      expect(policy.poll(DEBOUNCE)?.attention).toHaveLength(2);
    });
  });

  describe('run_finished', () => {
    it('flushes without waiting for the window', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('task_passed', 10, 't2'));
      policy.push(event('run_finished', 20));

      expect(policy.poll(20)).toEqual({
        attention: [event('task_failed', 0, 't1'), event('run_finished', 20)],
        sinceLast: [event('task_passed', 10, 't2')],
      });
    });

    it('wakes on its own with the passes, and leaves the policy open for a retry', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('run_finished', 20));

      expect(policy.poll(20)).toEqual({
        attention: [event('run_finished', 20)],
        sinceLast: [event('task_passed', 0, 't1')],
      });

      policy.push(event('waiting_input', 5000, 't1'));
      expect(policy.poll(5000 + DEBOUNCE)?.attention).toEqual([event('waiting_input', 5000, 't1')]);
    });
  });

  describe('idle de-duplication', () => {
    it('reports a task that goes idle twice in one window once, at its first place and stamp', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_idle', 0, 't1'));
      policy.push(event('task_failed', 100, 't2'));
      policy.push(event('task_idle', 200, 't1'));
      policy.push(event('task_idle', 300, 't3'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        event('task_idle', 0, 't1'),
        event('task_failed', 100, 't2'),
        event('task_idle', 300, 't3'),
      ]);
    });

    it('reports the same task idle again after a wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_idle', 0, 't1'));
      policy.poll(DEBOUNCE);

      policy.push(event('task_idle', 2000, 't1'));
      expect(policy.poll(2000 + DEBOUNCE)?.attention).toEqual([event('task_idle', 2000, 't1')]);
    });

    it('collapses only silence: two waiting_input events from one task both reach the supervisor', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push({ kind: 'waiting_input', taskId: 't1', at: 0, detail: 'Which database?' });
      policy.push({ kind: 'waiting_input', taskId: 't1', at: 300, detail: 'Overwrite the migration?' });

      expect(policy.poll(DEBOUNCE)?.attention.map((e) => e.detail)).toEqual([
        'Which database?',
        'Overwrite the migration?',
      ]);
    });

    it('keeps an idle report even when the task passes before the wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_idle', 0, 't1'));
      policy.push(event('task_passed', 500, 't1'));

      expect(policy.poll(DEBOUNCE)).toEqual({
        attention: [event('task_idle', 0, 't1')],
        sinceLast: [event('task_passed', 500, 't1')],
      });
    });
  });

  it('clears the batch on a wake-up, so each pass is reported once', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_failed', 10, 't2'));
    expect(policy.poll(10 + DEBOUNCE)?.sinceLast).toEqual([event('task_passed', 0, 't1')]);
    expect(policy.poll(10 + DEBOUNCE)).toBeNull();

    policy.push(event('task_failed', 2000, 't3'));
    expect(policy.poll(2000 + DEBOUNCE)?.sinceLast).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a debounce of %s', (debounceMs) => {
    expect(() => createWakePolicy({ debounceMs })).toThrow(RangeError);
  });
});
