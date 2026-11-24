import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstRunBDaemon, MACHINE_B_GOAL, type FirstRunBDaemon } from './firstRunBDaemon';

/*
 * Machine B's first run (slug sessionAtSend), over the daemon's HTTP API. The
 * user sent the goal and, while Claude Code was still on its first turn,
 * looked for the session in another window: it was not there, and when that
 * first turn crashed the session was gone with it, goal and error both.
 * Decided: the session exists from the moment the goal is sent, is listed
 * while the first turn is in flight, keeps its goal and the error when that
 * turn fails, and a stop sent during it stops the daemon's turn.
 */

describe('machine B, sessionAtSend: the session from the moment the goal is sent', () => {
  let daemon: FirstRunBDaemon;

  beforeEach(async () => { daemon = await firstRunBDaemon(); });
  afterEach(async () => { await daemon.close(); });

  it('is listed by the sessions route while the first turn is still in flight', async () => {
    const sent = daemon.sendGoal('s-b');
    await vi.waitFor(() => expect(daemon.turns).toHaveLength(1));
    expect(daemon.turns[0].asked).toContain('--shout');

    const listed = await daemon.listed();

    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: 's-b', goal: MACHINE_B_GOAL })]));
    daemon.turns[0].finish('Which greeting does hello.py print today?');
    expect((await sent).ok).toBe(true);
  });

  it('is still listed with its goal and the error when the first turn fails after it started', async () => {
    const sent = daemon.sendGoal('s-b');
    await vi.waitFor(() => expect(daemon.turns).toHaveLength(1));

    daemon.turns[0].fail(new Error('claude exited with code 1: the planner crashed'));
    const reply = await sent;
    expect(reply.ok).toBe(false);

    const listed = await daemon.listed();
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: 's-b', goal: MACHINE_B_GOAL })]));
    const read = await daemon.read('s-b');
    expect(read).not.toBeNull();
    expect(JSON.stringify(read)).toContain(MACHINE_B_GOAL);
    expect(JSON.stringify(read)).toContain('the planner crashed');
  });

  it('stops the daemon\'s turn when a stop is sent during the first turn', async () => {
    const sent = daemon.sendGoal('s-b');
    await vi.waitFor(() => expect(daemon.turns).toHaveLength(1));

    const stopped = await daemon.stopPlanning('s-b');

    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ cancelled: true });
    await vi.waitFor(() => expect(daemon.turns[0].signal?.aborted).toBe(true));
    await sent;
    expect(daemon.pool.session('s-b', undefined).isPlannerBusy).toBe(false);
  });
});
