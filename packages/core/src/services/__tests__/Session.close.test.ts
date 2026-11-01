import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorktreeIsolation } from '../../testing';
import type { LeaseHost, SessionLease } from '../sessionLease';
import { settled, supervised, task, until } from './supervisorTestKit';

/*
 * What a Session's `gone` promises (ADR-0049, ADR-0055 D13): a Stop's release of
 * a worktree outlives `destroy`, and while it runs the lease must stand, or a
 * next host takes the tree from under what is still writing it.
 */

describe('a Session closing with a change still in git', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  /** A run whose `change` waits for the test, with a lease that says when it went. */
  async function paused<K extends 'release' | 'integrate'>(change: K) {
    const isolation = new FakeWorktreeIsolation();
    const real = isolation[change].bind(isolation) as (...args: unknown[]) => Promise<never>;
    let finish = () => undefined as void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const state = { entered: false };
    (isolation[change] as unknown) = async (...args: unknown[]) => {
      state.entered = true;
      await finished;
      return real(...args);
    };
    const letGo = vi.fn();
    const lease: SessionLease = { claim: () => undefined, hold: () => null, release: letGo };
    const env = await supervised([task('t1', 1)], { isolation, leaseHost: { lease: () => lease } as unknown as LeaseHost, settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    await until(() => env.session.planTasks[0].status === 'in_progress');
    return { env, state, finish, letGo };
  }

  async function goesOnlyOnceFinished({ env, finish, letGo }: Awaited<ReturnType<typeof paused>>) {
    env.session.destroy();
    let gone = false;
    void env.session.gone.then(() => { gone = true; });
    await settled();
    expect(gone).toBe(false);
    expect(letGo).not.toHaveBeenCalled();

    finish();
    await vi.runAllTimersAsync();
    await env.session.gone;
    expect(letGo).toHaveBeenCalled();
  }

  it('is not gone, and keeps its lease, until a Stop\'s release has ended', async () => {
    await goesOnlyOnceFinished(await paused('release'));
  });

  it('waits the same for a task landing, with no runner left to wind down', async () => {
    const run = await paused('integrate');
    run.env.run.of('t1').reportComplete({ status: 'done', summary: 'Done.' } as never);
    await until(() => run.state.entered);

    await goesOnlyOnceFinished(run);
  });
});
