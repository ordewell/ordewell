import type { IRunner, IRunnerSession, RunnerSpawnOptions } from '@ordewell/core';
import type { SessionBroadcaster } from '@ordewell/core';

/** How long a task's output gathers before it goes out as one frame. */
const OUTPUT_WINDOW_MS = 100;

export class PoolAwareRunner implements IRunner {
  /**
   * Sessions this plan spawned. The inner runner is shared by every plan in
   * the pool, so "stop everything" and "how many are running" must be
   * answered from this set, never delegated — delegating would let one plan's
   * /stop kill another plan's tasks.
   */
  private owned = new Set<string>();
  /** Each live session's way to tell what it printed that no frame carries yet. */
  private flushers = new Map<string, () => void>();

  constructor(
    private sessionId: string,
    private broadcast: SessionBroadcaster,
    private inner: IRunner,
  ) {}

  get activeCount(): number { return this.owned.size; }

  async spawn(opts: RunnerSpawnOptions): Promise<IRunnerSession> {
    const session = await this.inner.spawn({ ...opts, planSessionId: this.sessionId });
    this.owned.add(session.id);
    const output = this.outputOf(opts.taskId);
    this.flushers.set(session.id, output.flush);
    // Registered before the caller can register its own, so the output is told before the end is.
    session.onExit(() => {
      output.flush();
      this.owned.delete(session.id);
      this.flushers.delete(session.id);
    });
    this.broadcast({ type: 'task_started', taskId: opts.taskId, order: opts.order ?? 0, title: opts.title ?? '', runner: opts.runner, modelId: opts.modelId });
    session.onOutput(output.add);
    return session;
  }

  /**
   * A runner's output arrives in chunks as small as a line, and every frame is
   * stamped, serialized and sent to every socket. One frame per window carries
   * the same bytes in the same order, and the message itself is unchanged
   * (ADR-0063): a surface appends the text it receives.
   */
  private outputOf(taskId: string): { add: (text: string) => void; flush: () => void } {
    let pending = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (pending === '') return;
      const text = pending;
      pending = '';
      this.broadcast({ type: 'task_output', taskId, text });
    };
    return {
      add: (text) => {
        pending += text;
        timer ??= setTimeout(flush, OUTPUT_WINDOW_MS);
      },
      flush,
    };
  }

  stop(sessionId: string): Promise<void> {
    this.flushers.get(sessionId)?.();
    this.owned.delete(sessionId);
    return this.inner.stop(sessionId);
  }

  stopAll(): void {
    for (const id of this.owned) {
      this.flushers.get(id)?.();
      void this.inner.stop(id);
    }
    this.owned.clear();
  }
}
