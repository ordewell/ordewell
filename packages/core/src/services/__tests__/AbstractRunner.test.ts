import { describe, it, expect } from 'vitest';
import { AbstractRunner } from '../AbstractRunner';
import { FakeRunnerSession } from '../../testing';
import type { IRunnerSession } from '../../interfaces/IRunner';

/** A transport that hands out a fixed id, the way the old per-task ids did. */
class FixedIdRunner extends AbstractRunner<FakeRunnerSession> {
  async spawn(opts: { taskId: string }): Promise<IRunnerSession> {
    const session = new FakeRunnerSession('fixed-id', opts.taskId);
    this.registerSession(session.id, session);
    return session;
  }
}

describe('AbstractRunner', () => {
  it('ignores a replaced session exiting under an id its successor now holds', async () => {
    const runner = new FixedIdRunner();
    const old = (await runner.spawn({ taskId: 't1' })) as FakeRunnerSession;
    const successor = (await runner.spawn({ taskId: 't1' })) as FakeRunnerSession;

    old.emitExit(1);

    expect(runner.activeCount).toBe(1);
    runner.stop('fixed-id');
    expect(successor.killed).toBe(true);
  });
});
