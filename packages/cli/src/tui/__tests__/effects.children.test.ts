import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { Action } from '../reducer';
import { type SessionSocket, type SocketEnd } from '../../apiClient';
import { DaemonRefusal } from '@ordewell/core';

const ROOT = 'root-session';
const CHILD = 'child-session';
const VIEW = { child: { sessionId: CHILD, node: 'root/1', parent: ROOT, taskId: 'd', title: 'Delegated', depth: 1, state: 'working' } };

/** One socket's life, ended by the test with the close code the daemon would send. */
function socket(opens = true) {
  let settle: (end: SocketEnd | null) => void = () => {};
  const ended = new Promise<SocketEnd | null>((resolve) => { settle = resolve; });
  const end = (code: number | null) => settle(code === null ? null : { code });
  const close = vi.fn(() => end(null));
  const follow: SessionSocket = { ready: Promise.resolve(opens), ended, close };
  return { follow, end, close };
}

function harness(over: Record<string, unknown> = {}) {
  const actions: Action[] = [];
  const sockets: ReturnType<typeof socket>[] = [];
  const api = {
    followChild: vi.fn((_root: string, _child: string, _onEvent: unknown) => {
      const opened = socket();
      sockets.push(opened);
      return opened.follow;
    }),
    getChild: vi.fn().mockResolvedValue(VIEW),
    listChildren: vi.fn().mockResolvedValue({ children: [] }),
    messageChild: vi.fn().mockResolvedValue({ status: 'queued' }),
    messageChildTask: vi.fn().mockResolvedValue({ status: 'queued' }),
    answerChildCheckpoint: vi.fn().mockResolvedValue({ ok: true }),
    approveTaskCheckpoint: vi.fn().mockResolvedValue({ ok: true }),
    rejectTaskCheckpoint: vi.fn().mockResolvedValue({ ok: true }),
    getChildTaskLogAttempts: vi.fn().mockResolvedValue({ attempts: [2], position: 3 }),
    getChildTaskLog: vi.fn().mockResolvedValue({ attempt: 2, events: [] }),
    getTaskLogAttempts: vi.fn().mockResolvedValue({ attempts: [] }),
    getTaskLog: vi.fn().mockResolvedValue({ attempt: 1, events: [] }),
    ...over,
  };
  const deps = { api: api as unknown as OrdewellApi, workspace: '/w', port: 1, dispatch: (action: Action) => { actions.push(action); }, reviveDaemon: vi.fn().mockResolvedValue(true) } as unknown as EffectDeps;
  return { deps, api, actions, sockets };
}

const of = (actions: Action[], type: Action['type']) => actions.filter((a) => a.type === type);
const open = (deps: EffectDeps) => runEffect({ type: 'followChild', rootId: ROOT, childId: CHILD }, deps);
const REFUSED = new DaemonRefusal('This plan has ended.', 409, { code: 'child_view_only' });
const UNLISTED = new DaemonRefusal('No such child.', 404, { code: 'child_not_found' });

describe('a checkpoint answered from a plan below the one that holds it', () => {
  const NOT_WAITING = new DaemonRefusal('No longer waiting.', 409, { code: 'checkpoint_not_waiting' });

  it('comes back as that plan\'s refusal, with the words it carried', async () => {
    const h = harness({ rejectTaskCheckpoint: vi.fn().mockRejectedValue(NOT_WAITING) });

    await runEffect({ type: 'answerTaskCheckpoint', sessionId: ROOT, taskId: 'd', answer: 'reject', reason: 'not yet', below: true }, h.deps);

    expect(of(h.actions, 'childFailed')).toEqual([{ type: 'childFailed', sessionId: ROOT, code: 'checkpoint_not_waiting', message: 'No longer waiting.', text: 'not yet' }]);
    expect(of(h.actions, 'failed')).toEqual([]);
  });

  it('gives a raise back as the number that was typed', async () => {
    const h = harness({ approveTaskCheckpoint: vi.fn().mockRejectedValue(NOT_WAITING) });

    await runEffect({ type: 'answerTaskCheckpoint', sessionId: ROOT, taskId: 'd', answer: 'approve', raiseTokens: 5000, below: true }, h.deps);

    expect(h.api.approveTaskCheckpoint).toHaveBeenCalledWith(ROOT, 'd', { raiseTokens: 5000 });
    expect(of(h.actions, 'childFailed')).toEqual([{ type: 'childFailed', sessionId: ROOT, code: 'checkpoint_not_waiting', message: 'No longer waiting.', text: '5000' }]);
  });

  it('leaves the root\'s own answer on the root\'s failure path', async () => {
    const h = harness({ rejectTaskCheckpoint: vi.fn().mockRejectedValue(NOT_WAITING) });

    await runEffect({ type: 'answerTaskCheckpoint', sessionId: ROOT, taskId: 'd', answer: 'reject', reason: 'not yet' }, h.deps);

    expect(of(h.actions, 'childFailed')).toEqual([]);
    expect(of(h.actions, 'failed')).toHaveLength(1);
  });
});

describe('following a child plan', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the plan once its socket is open, and holds one link however often it is asked', async () => {
    const h = harness();
    await open(h.deps);
    await open(h.deps);

    expect(h.api.followChild).toHaveBeenCalledTimes(1);
    expect(h.api.followChild.mock.calls[0].slice(0, 2)).toEqual([ROOT, CHILD]);
    expect(of(h.actions, 'childOpened')).toEqual([{ type: 'childOpened', sessionId: CHILD, view: VIEW }]);
  });

  it('closes the plan with its root when the root is gone', async () => {
    const h = harness();
    await open(h.deps);

    h.sockets[0].end(1001);
    await vi.advanceTimersByTimeAsync(0);

    expect(of(h.actions, 'childGone')).toEqual([{ type: 'childGone', sessionId: CHILD, message: 'The session above this plan closed, so this plan closed with it.' }]);
    expect(h.sockets[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.api.followChild).toHaveBeenCalledTimes(1);
  });

  it('leaves a plan the read no longer finds', async () => {
    const h = harness();
    await open(h.deps);
    h.api.getChild.mockRejectedValue(UNLISTED);

    h.sockets[0].end(4404);
    await vi.advanceTimersByTimeAsync(0);

    expect(of(h.actions, 'childGone')).toEqual([{ type: 'childGone', sessionId: CHILD, message: 'That plan is no longer in this session.' }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.api.followChild).toHaveBeenCalledTimes(1);
  });

  it('comes back from a 4404 the read answers, which is a root the daemon had not loaded', async () => {
    const h = harness();
    await open(h.deps);

    h.sockets[0].end(4404);
    await vi.advanceTimersByTimeAsync(500);

    expect(of(h.actions, 'childGone')).toEqual([]);
    expect(of(h.actions, 'followLost')).toEqual([]);
    expect(h.api.followChild).toHaveBeenCalledTimes(2);
  });

  it('keeps trying through a 4404 whose read fails for any other reason', async () => {
    const h = harness();
    await open(h.deps);
    h.api.getChild.mockRejectedValueOnce(new DaemonRefusal('Busy.', 503));

    h.sockets[0].end(4404);
    await vi.advanceTimersByTimeAsync(500);

    expect(of(h.actions, 'childGone')).toEqual([]);
    expect(h.api.followChild).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the root is replaced, and comes straight back', async () => {
    const h = harness();
    await open(h.deps);

    h.sockets[0].end(1012);
    await vi.advanceTimersByTimeAsync(500);

    expect(of(h.actions, 'followLost')).toEqual([]);
    expect(h.api.followChild).toHaveBeenCalledTimes(2);
    expect(of(h.actions, 'childOpened')).toHaveLength(2);
  });

  it('says it lost the plan once for an outage, however many sockets the outage takes', async () => {
    const h = harness();
    h.api.followChild.mockImplementation(() => {
      const lost = socket(false);
      h.sockets.push(lost);
      return lost.follow;
    });
    await open(h.deps);

    h.sockets[0].end(1006);
    await vi.advanceTimersByTimeAsync(500);
    h.sockets[1].end(1006);
    await vi.advanceTimersByTimeAsync(1000);

    expect(of(h.actions, 'followLost')).toEqual([{ type: 'followLost', sessionId: CHILD }]);
    expect(h.api.followChild).toHaveBeenCalledTimes(3);
  });

  it('counts a new outage again once a socket has read the plan', async () => {
    const h = harness();
    await open(h.deps);

    h.sockets[0].end(1006);
    await vi.advanceTimersByTimeAsync(500);
    h.sockets[1].end(1006);
    await vi.advanceTimersByTimeAsync(500);

    expect(of(h.actions, 'followLost')).toHaveLength(2);
  });

  describe('a read that fails on an open socket', () => {
    const BUSY = new DaemonRefusal('Busy.', 503);

    it('reads again on a socket of its own after a reconnect, and says nothing more', async () => {
      const h = harness();
      await open(h.deps);
      h.sockets[0].end(1006);
      await vi.advanceTimersByTimeAsync(0);
      h.api.getChild.mockRejectedValueOnce(BUSY);

      await vi.advanceTimersByTimeAsync(600_000);

      expect(h.sockets).toHaveLength(3);
      expect(h.api.getChild).toHaveBeenCalledTimes(3);
      expect(h.sockets[1].close).toHaveBeenCalled();
      expect(h.sockets[2].close).not.toHaveBeenCalled();
      expect(of(h.actions, 'childOpened')).toHaveLength(2);
      expect(of(h.actions, 'failed')).toEqual([]);
    });

    it('waits longer each time, up to the most a lost socket waits', async () => {
      const h = harness();
      await open(h.deps);
      h.api.getChild.mockRejectedValue(BUSY);
      h.sockets[0].end(1006);

      await vi.advanceTimersByTimeAsync(499);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(3);

      // 2s, 4s, then 8s for as long as the reads fail.
      await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 3 * 8_000);
      expect(h.sockets).toHaveLength(8);
      expect(h.sockets.slice(1, -1).every((s) => s.close.mock.calls.length > 0)).toBe(true);
    });

    it('recovers on the first open: the failure shows, the plan is told, and a later read lands', async () => {
      const h = harness({ getChild: vi.fn().mockRejectedValueOnce(BUSY).mockResolvedValue(VIEW) });

      await open(h.deps);

      expect(of(h.actions, 'failed')).toEqual([expect.objectContaining({ type: 'failed', message: 'Busy.' })]);
      expect(of(h.actions, 'followLost')).toEqual([{ type: 'followLost', sessionId: CHILD }]);
      expect(h.sockets[0].close).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);

      expect(of(h.actions, 'childOpened')).toEqual([{ type: 'childOpened', sessionId: CHILD, view: VIEW }]);
      expect(h.sockets).toHaveLength(2);
    });

    it('tells the plan even when the close that started it said nothing', async () => {
      const h = harness();
      await open(h.deps);
      h.sockets[0].end(1012);
      await vi.advanceTimersByTimeAsync(0);
      h.api.getChild.mockRejectedValueOnce(BUSY);

      await vi.advanceTimersByTimeAsync(500);

      expect(of(h.actions, 'followLost')).toEqual([{ type: 'followLost', sessionId: CHILD }]);
    });

    it('asks once when the socket ends under the read', async () => {
      let refuse: (err: unknown) => void = () => {};
      const h = harness();
      await open(h.deps);
      h.api.getChild.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
      h.sockets[0].end(1006);
      await vi.advanceTimersByTimeAsync(500);

      h.sockets[1].end(1006);
      await vi.advanceTimersByTimeAsync(0);
      refuse(BUSY);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(h.sockets).toHaveLength(3);
    });

    it('leaves a newer socket alone when an old read fails late', async () => {
      let refuse: (err: unknown) => void = () => {};
      const h = harness();
      await open(h.deps);
      h.api.getChild.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }));
      h.sockets[0].end(1006);
      await vi.advanceTimersByTimeAsync(500);
      h.sockets[1].end(1006);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(3);

      refuse(BUSY);
      await vi.advanceTimersByTimeAsync(600_000);

      expect(h.sockets).toHaveLength(3);
      expect(h.sockets[2].close).not.toHaveBeenCalled();
    });

    it('stops there when the person left while it was on its way', async () => {
      let refuse: (err: unknown) => void = () => {};
      const h = harness({ getChild: vi.fn(() => new Promise((_, reject) => { refuse = reject; })) });
      const opening = open(h.deps);
      await vi.advanceTimersByTimeAsync(0);

      await runEffect({ type: 'closeChild', childId: CHILD }, h.deps);
      refuse(BUSY);
      await opening;
      await vi.advanceTimersByTimeAsync(600_000);

      expect(h.sockets).toHaveLength(1);
      expect(of(h.actions, 'followLost')).toEqual([]);
      expect(of(h.actions, 'failed')).toEqual([]);
    });
  });

  it('stops for good when the person leaves the plan, with a retry already waiting', async () => {
    const h = harness();
    await open(h.deps);
    h.sockets[0].end(1006);
    await vi.advanceTimersByTimeAsync(0);

    await runEffect({ type: 'closeChild', childId: CHILD }, h.deps);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.api.followChild).toHaveBeenCalledTimes(1);
  });

  it('ignores the close that the person leaving caused', async () => {
    const h = harness();
    await open(h.deps);

    await runEffect({ type: 'closeChild', childId: CHILD }, h.deps);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.sockets[0].close).toHaveBeenCalled();
    expect(of(h.actions, 'followLost')).toEqual([]);
    expect(of(h.actions, 'childGone')).toEqual([]);
  });

  it('ignores a daemon\'s close that crosses the person leaving', async () => {
    const h = harness();
    await open(h.deps);

    h.sockets[0].end(1001);
    await runEffect({ type: 'closeChild', childId: CHILD }, h.deps);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(of(h.actions, 'childGone')).toEqual([]);
    expect(h.api.followChild).toHaveBeenCalledTimes(1);
  });

  it('drops a read that lands after the person left', async () => {
    let answer: (view: unknown) => void = () => {};
    const h = harness({ getChild: vi.fn(() => new Promise((resolve) => { answer = resolve; })) });
    const opening = open(h.deps);
    await vi.advanceTimersByTimeAsync(0);

    await runEffect({ type: 'closeChild', childId: CHILD }, h.deps);
    answer(VIEW);
    await opening;

    expect(of(h.actions, 'childOpened')).toEqual([]);
  });

  it('leaves a plan its first read cannot find', async () => {
    const h = harness({ getChild: vi.fn().mockRejectedValue(UNLISTED) });

    await open(h.deps);

    expect(of(h.actions, 'childGone')).toEqual([{ type: 'childGone', sessionId: CHILD, message: 'That plan is no longer in this session.' }]);
    expect(h.sockets[0].close).toHaveBeenCalled();
  });
});

describe('asking the daemon on a child plan', () => {
  it('tells the reducer the daemon\'s refusal, code and all, and hands back the person\'s words', async () => {
    const h = harness({ messageChild: vi.fn().mockRejectedValue(REFUSED) });

    await runEffect({ type: 'messageChild', rootId: ROOT, childId: CHILD, text: 'my words' }, h.deps);

    expect(of(h.actions, 'childFailed')).toEqual([{ type: 'childFailed', sessionId: CHILD, message: 'This plan has ended.', code: 'child_view_only', text: 'my words' }]);
  });

  it('leaves anything but a refusal to the daemon-revival path', async () => {
    const away = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const h = harness({ messageChildTask: vi.fn().mockRejectedValue(away) });

    await runEffect({ type: 'messageChildTask', rootId: ROOT, childId: CHILD, taskId: 'a', text: 'hello' }, h.deps);

    expect(h.deps.reviveDaemon).toHaveBeenCalled();
    expect(of(h.actions, 'childFailed')).toEqual([]);
  });

  it('hands back the words of a refused checkpoint answer, which the composer no longer holds', async () => {
    const h = harness({ answerChildCheckpoint: vi.fn().mockRejectedValue(REFUSED) });

    await runEffect({ type: 'answerChildCheckpoint', rootId: ROOT, childId: CHILD, taskId: 'a', answer: 'reject', question: 'Ship it?', reason: 'not yet' }, h.deps);

    expect(of(h.actions, 'childFailed')).toEqual([{ type: 'childFailed', sessionId: CHILD, message: 'This plan has ended.', code: 'child_view_only', text: 'not yet' }]);
  });

  it('says what a message did to the plan', async () => {
    const h = harness();

    await runEffect({ type: 'messageChild', rootId: ROOT, childId: CHILD, text: 'hello' }, h.deps);

    expect(h.api.messageChild).toHaveBeenCalledWith(ROOT, CHILD, 'hello');
    expect(of(h.actions, 'childMessaged')).toEqual([{ type: 'childMessaged', sessionId: CHILD, status: 'queued' }]);
  });

  it('answers a checkpoint by its words on the child\'s route', async () => {
    const h = harness();

    await runEffect({ type: 'answerChildCheckpoint', rootId: ROOT, childId: CHILD, taskId: 'a', answer: 'reject', question: 'Ship it?', reason: 'not yet' }, h.deps);

    expect(h.api.answerChildCheckpoint).toHaveBeenCalledWith(ROOT, CHILD, 'a', { answer: 'reject', question: 'Ship it?', reason: 'not yet' });
  });

  it('reads a child task\'s log from the child\'s route, where a root\'s would not find it', async () => {
    const h = harness();

    await runEffect({ type: 'openTaskLog', sessionId: CHILD, rootId: ROOT, taskId: 'a' }, h.deps);

    expect(h.api.getChildTaskLogAttempts).toHaveBeenCalledWith(ROOT, CHILD, 'a');
    expect(h.api.getChildTaskLog).toHaveBeenCalledWith(ROOT, CHILD, 'a', 2);
    expect(h.api.getTaskLogAttempts).not.toHaveBeenCalled();
    expect(of(h.actions, 'taskLogLoaded')).toEqual([{ type: 'taskLogLoaded', taskId: 'a', attempts: [2], attempt: 2, events: [], sessionId: CHILD }]);
  });

  it('hands the listing back with the plan it was fetched to open', async () => {
    const h = harness({ listChildren: vi.fn().mockResolvedValue({ children: [VIEW.child] }) });
    const opening = { taskId: 'd', parent: ROOT } as unknown as Extract<Parameters<typeof runEffect>[0], { type: 'listChildren' }>['open'];

    await runEffect({ type: 'listChildren', rootId: ROOT, open: opening }, h.deps);

    expect(of(h.actions, 'childrenListed')).toEqual([{ type: 'childrenListed', sessionId: ROOT, children: [VIEW.child], open: opening }]);
  });
});
