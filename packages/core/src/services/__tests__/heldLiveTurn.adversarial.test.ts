import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { flushMicrotasks } from '../../testing';
import { LEASE_STALE_MS, LeaseHost, SessionHeldError } from '../sessionLease';
import { fakeConfig, makeSession } from './sessionTestKit';
import { heldPlanner, plan, prose, settled, until } from './supervisorTestKit';
import { saveSession } from '../../utils/sessionStore';

/**
 * A planner turn already in flight when another host takes the session is not
 * stopped by `leaseLost`: it runs to the end, the plan takes the reply, and
 * `capturePrd` writes the PRD into a checkout the other host now holds
 * (ADR-0049: a host that does not hold the session runs none of its work).
 * Only a turn that opens after the takeover is refused.
 */

const PRD = '<!-- ORDEWELL_PRD_START slug="sub" --># A PRD<!-- ORDEWELL_PRD_END -->';

describe('a planner turn in flight when another host takes the session', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  function heldTurn() {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-held-live-turn-')));
    const host = new LeaseHost();
    const taker = new LeaseHost({ now: () => Date.now() + 2 * LEASE_STALE_MS });
    const planner = heldPlanner();
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true }),
      aiService: planner.aiService,
      leaseHost: host,
      saveSession,
      workspaceRoot: () => workspace,
    });
    session.loadPlan(plan([]), 'goal', workspace, { sessionId: 'root' });
    return {
      workspace, planner, session,
      // Another host judged this process gone and took the session; this one finds out at its next beat.
      takeOver: () => {
        taker.lease(() => undefined).claim('root', workspace);
        host.beat();
        expect(session.heldElsewhere()?.holder.hostId).toBe(taker.id);
      },
      cleanup: () => {
        taker.releaseAll();
        host.releaseAll();
        session.destroy();
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  }

  it('is stopped, so it writes no PRD into the checkout the other host holds', async () => {
    const { workspace, planner, session, takeOver, cleanup } = heldTurn();
    try {
      const turn = session.continueConversation(`write ${PRD}`);
      await until(() => planner.calls.length === 1);
      expect(session.isPlannerBusy).toBe(true);

      takeOver();
      await flushMicrotasks();

      planner.calls[0].finish(prose(PRD));
      await turn.catch(() => undefined);
      await settled();

      expect(session.planState?.prdMarkdown).toBeUndefined();
      expect(existsSync(join(workspace, '.scratch', 'sub', 'PRD.md'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('lands nothing even when its backend answers past the stop', async () => {
    const { workspace, planner, session, takeOver, cleanup } = heldTurn();
    planner.state.ignoresStop = true;
    try {
      const turn = session.continueConversation(`write ${PRD}`);
      await until(() => planner.calls.length === 1);

      takeOver();
      await flushMicrotasks();

      planner.calls[0].finish(prose(PRD));
      await turn.catch(() => undefined);
      await settled();

      expect(session.planState?.prdMarkdown).toBeUndefined();
      expect(existsSync(join(workspace, '.scratch', 'sub', 'PRD.md'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('leaves what waits behind it to be refused with the hold as its reason', async () => {
    const { planner, session, takeOver, cleanup } = heldTurn();
    try {
      const turn = session.continueConversation('first');
      await until(() => planner.calls.length === 1);
      const behind = session.continueConversation('second');
      const heard = behind.catch((err: unknown) => err);

      takeOver();
      await turn.catch(() => undefined);

      expect(await heard).toBeInstanceOf(SessionHeldError);
      expect(planner.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
