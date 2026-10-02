/**
 * When the supervisor wakes during a run, and what it is told (#27). Only an
 * attention event wakes it; passes ride along as context. It keeps no clock:
 * the host stamps each event and polls on its own tick.
 */

export type RunEvent = {
  kind: 'task_passed' | 'task_failed' | 'waiting_input' | 'waiting_approval' | 'task_idle' | 'landing_conflict' | 'run_finished';
  taskId?: string;
  /** Epoch ms, on the same clock the host passes to `poll`. */
  at: number;
  detail?: string;
};

export interface WakeBatch {
  /** What woke the supervisor, in arrival order; never empty. */
  attention: RunEvent[];
  /** The passes since the previous wake-up. */
  sinceLast: RunEvent[];
}

export interface WakePolicyOptions {
  /** How long the first attention event waits for others to join its wake-up. */
  debounceMs: number;
}

export interface WakePolicy {
  push(event: RunEvent): void;
  poll(now: number): WakeBatch | null;
}

export function createWakePolicy(options: WakePolicyOptions): WakePolicy {
  const { debounceMs } = options;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError(`debounceMs must be a finite, non-negative number of milliseconds, got ${debounceMs}`);
  }

  let attention: RunEvent[] = [];
  let sinceLast: RunEvent[] = [];

  return {
    push(event) {
      if (event.kind === 'task_passed') {
        sinceLast.push(event);
        return;
      }
      // Only silence collapses: a task flickering between silence and output
      // is one fact, while two waiting_input events are two questions.
      if (event.kind === 'task_idle' && attention.some((e) => e.kind === 'task_idle' && e.taskId === event.taskId)) return;
      attention.push(event);
    },

    poll(now) {
      const first = attention[0];
      if (!first) return null;
      // A fixed window from the first attention event: one that restarted on
      // each event could be held off by tasks that keep settling. run_finished
      // skips it, as nothing later in the run can join the batch.
      const due = now - first.at >= debounceMs || attention.some((e) => e.kind === 'run_finished');
      if (!due) return null;
      const batch = { attention, sinceLast };
      attention = [];
      sinceLast = [];
      return batch;
    },
  };
}
