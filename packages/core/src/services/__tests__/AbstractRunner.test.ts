import { describe, it, expect } from 'vitest';
import { AbstractRunner } from '../AbstractRunner';
import { FakeTerminalSession } from '../../testing';
import type { ITerminalSession } from '../../interfaces/ITerminalRunner';

/** A transport that hands out a fixed id, the way the old per-task ids did. */
class FixedIdRunner extends AbstractRunner<FakeTerminalSession> {
  async spawn(opts: { taskId: string }): Promise<ITerminalSession> {
    const session = new FakeTerminalSession('fixed-id', opts.taskId);
    this.registerSession(session.id, session);
    return session;
  }
}

describe('AbstractRunner', () => {
  it('ignores a replaced session exiting under an id its successor now holds', async () => {
    const runner = new FixedIdRunner();
    const old = (await runner.spawn({ taskId: 't1' })) as FakeTerminalSession;
    const successor = (await runner.spawn({ taskId: 't1' })) as FakeTerminalSession;

    old.emitExit(1);

    expect(runner.activeCount).toBe(1);
    runner.stop('fixed-id');
    expect(successor.killed).toBe(true);
  });
});
