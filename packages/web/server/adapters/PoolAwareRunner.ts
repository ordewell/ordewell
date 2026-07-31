import { HeadlessRunner, type ITerminalRunner, type ITerminalSession, type RunnerId } from '@ordewell/core';
import type { SessionBroadcaster } from '@ordewell/core';

export class PoolAwareRunner implements ITerminalRunner {
  private inner: ITerminalRunner;
  /**
   * Sessions this plan spawned. The inner runner may be shared by every plan
   * in the pool (one tmux session per daemon), so "stop everything" and
   * "how many are running" must be answered from this set, never delegated —
   * delegating would let one plan's /stop kill another plan's tasks.
   */
  private owned = new Set<string>();

  constructor(
    private sessionId: string,
    private broadcast: SessionBroadcaster,
    inner?: ITerminalRunner,
  ) {
    this.inner = inner ?? new HeadlessRunner();
  }

  get activeCount(): number { return this.owned.size; }

  async spawn(opts: { taskId: string; runner: RunnerId; prompt: string; modelId?: string; thinkingEffort?: string; modelVariants?: string[]; mode?: 'build' | 'plan'; headless?: boolean; cwd: string; order?: number; title?: string }): Promise<ITerminalSession> {
    const session = await this.inner.spawn({ ...opts, planSessionId: this.sessionId });
    this.owned.add(session.id);
    session.onExit(() => this.owned.delete(session.id));
    this.broadcast({ type: 'task_started', taskId: opts.taskId, order: opts.order ?? 0, title: opts.title ?? '', runner: opts.runner, modelId: opts.modelId });
    session.onOutput((text) => {
      this.broadcast({ type: 'task_output', taskId: opts.taskId, text });
    });
    return session;
  }

  stop(sessionId: string): void {
    this.inner.stop(sessionId);
    this.owned.delete(sessionId);
  }

  stopAll(): void {
    for (const id of this.owned) this.inner.stop(id);
    this.owned.clear();
  }
}
