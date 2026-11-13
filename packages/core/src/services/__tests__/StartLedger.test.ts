import { describe, expect, it, vi } from 'vitest';
import { StartLedger, type LoadedPlan, type Offer, type QueuedStart, type StartClaimant } from '../StartLedger';

const RELEASES = ['retried', 'forced', 'moved', 'roundStarted', 'completed', 'skipped', 'left'] as const;

const AT_GATE: QueuedStart = { pastGate: [] };
const REOPEN = { message: 'go on', resumeSessionId: 's1' };

/** A plan that has the tasks `has` names. */
function planOf(has: (taskId: string) => boolean): LoadedPlan {
  return { has };
}

const ALL_OWED = (): boolean => true;

/** A claimant that answers each owed start from a table, recording what it was offered. */
function claimant(answers: { queued?: Record<string, Offer<() => Promise<void>>>; repair?: Record<string, Offer<() => void>>; resume?: Record<string, Offer<() => void>> } = {}) {
  const offered: string[] = [];
  const stub: StartClaimant<string> = {
    queued: (id) => {
      offered.push(`queued:${id}`);
      return answers.queued?.[id] ?? 'waits';
    },
    repair: (id, admission) => {
      offered.push(`repair:${id}@${admission}`);
      return answers.repair?.[id] ?? 'waits';
    },
    resume: (id) => {
      offered.push(`resume:${id}`);
      return answers.resume?.[id] ?? 'waits';
    },
  };
  return { stub, offered };
}

function ledgerOf(answers: Parameters<typeof claimant>[0] = {}) {
  const { stub, offered } = claimant(answers);
  return { ledger: new StartLedger<string>(stub), offered };
}

describe('StartLedger holds', () => {
  it('holds a task with the reason the surfaces show, and answers none for one not held', () => {
    const { ledger } = ledgerOf();
    ledger.hold('a', 'cancelled', 'chosen');
    expect(ledger.holdReason('a')).toBe('cancelled');
    expect(ledger.holds.has('a')).toBe(true);
    expect(ledger.holds.get('a')).toBe('cancelled');
    expect(ledger.holdReason('b')).toBeNull();
    expect(ledger.holds.has('b')).toBe(false);
    expect(ledger.holds.get('b')).toBeUndefined();
  });

  it.each(RELEASES)('%s releases a hold of either kind, and only that task\'s', (event) => {
    const { ledger } = ledgerOf();
    ledger.hold('a', 'cancelled', 'chosen');
    ledger.hold('b', 'spawn failed', 'failed-start');
    ledger.hold('c', 'reverted', 'chosen');
    ledger[event]('a');
    ledger[event]('b');
    expect(ledger.holds.has('a')).toBe(false);
    expect(ledger.holds.has('b')).toBe(false);
    expect(ledger.holdReason('c')).toBe('reverted');
  });

  it.each(['user', 'restart'] as const)('a %s stop releases a failed start\'s hold and keeps a chosen one', (reason) => {
    const { ledger } = ledgerOf();
    ledger.hold('chosen', 'cancelled', 'chosen');
    ledger.hold('failed', 'spawn failed', 'failed-start');
    ledger.stopped(reason);
    expect(ledger.holdReason('chosen')).toBe('cancelled');
    expect(ledger.holds.has('failed')).toBe(false);
  });

  it('a later hold replaces the reason and the kind: a chosen hold over a failed start\'s survives a stop', () => {
    const { ledger } = ledgerOf();
    ledger.hold('a', 'spawn failed', 'failed-start');
    ledger.hold('a', 'cancelled', 'chosen');
    ledger.stopped('user');
    expect(ledger.holdReason('a')).toBe('cancelled');
    ledger.hold('a', 'spawn failed again', 'failed-start');
    ledger.stopped('user');
    expect(ledger.holds.has('a')).toBe(false);
  });

  it('a plan that keeps holds keeps the chosen ones of tasks it still has', () => {
    const { ledger } = ledgerOf();
    ledger.hold('kept', 'cancelled', 'chosen');
    ledger.hold('gone', 'marked not done', 'chosen');
    ledger.hold('failed', 'spawn failed', 'failed-start');
    ledger.planLoaded(planOf((id) => id !== 'gone'), { keepsChosen: true, edited: false });
    expect(ledger.holdReason('kept')).toBe('cancelled');
    expect(ledger.holds.has('gone')).toBe(false);
    expect(ledger.holds.has('failed')).toBe(false);
  });

  it('another plan releases every hold', () => {
    const { ledger } = ledgerOf();
    ledger.hold('a', 'cancelled', 'chosen');
    ledger.hold('b', 'spawn failed', 'failed-start');
    ledger.planLoaded(planOf(() => true), { keepsChosen: false, edited: false });
    expect(ledger.holds.has('a')).toBe(false);
    expect(ledger.holds.has('b')).toBe(false);
  });

  it('a hold released by an event is gone for good: a later stop or reload does not bring it back', () => {
    const { ledger } = ledgerOf();
    ledger.hold('a', 'cancelled', 'chosen');
    ledger.retried('a');
    ledger.stopped('user');
    ledger.planLoaded(planOf(() => true), { keepsChosen: true, edited: true });
    expect(ledger.holds.has('a')).toBe(false);
  });
});

describe('StartLedger owed starts', () => {
  it('owes nothing at first', () => {
    const { ledger } = ledgerOf();
    expect(ledger.pendingUnasked()).toBe(false);
    expect(ledger.owesRepairs).toBe(false);
    expect(ledger.keptChildren).toEqual([]);
    expect(ledger.queued.has('a')).toBe(false);
  });

  it('counts every queued start as pending unless the reader names which move, and every repair and kept resume regardless', () => {
    const { ledger } = ledgerOf();
    ledger.queue('a', AT_GATE);
    expect(ledger.queued.has('a')).toBe(true);
    expect(ledger.pendingUnasked()).toBe(true);
    expect(ledger.pendingUnasked(() => false)).toBe(false);
    expect(ledger.pendingUnasked((id) => id === 'a')).toBe(true);

    ledger.oweRepair('r');
    expect(ledger.owesRepair('r')).toBe(true);
    expect(ledger.owesRepair('a')).toBe(false);
    expect(ledger.owesRepairs).toBe(true);
    expect(ledger.pendingUnasked(() => false)).toBe(true);

    ledger.cancelled('r');
    expect(ledger.pendingUnasked(() => false)).toBe(false);
    ledger.keepResume('k');
    expect(ledger.pendingUnasked(() => false)).toBe(true);
  });

  it('a claim takes the reopen a Continue owed the task, once', () => {
    const { ledger } = ledgerOf();
    ledger.oweReopen('a', REOPEN);
    expect(ledger.claimed('b')).toBeNull();
    expect(ledger.claimed('a')).toEqual(REOPEN);
    expect(ledger.claimed('a')).toBeNull();
  });

  it('a child a Continue could not reopen is kept, and held as chosen', () => {
    const { ledger } = ledgerOf();
    ledger.keepChild('c', 'did not reopen');
    expect(ledger.keptChildren).toEqual(['c']);
    expect(ledger.holdReason('c')).toBe('did not reopen');
    ledger.stopped('restart');
    expect(ledger.holdReason('c')).toBe('did not reopen');
  });

  it('a force start made now ends what was queued for it, and keeps its hold for the start to release', () => {
    const { ledger } = ledgerOf();
    ledger.hold('a', 'cancelled', 'chosen');
    ledger.queue('a', AT_GATE);
    ledger.forcedNow('a');
    expect(ledger.queued.has('a')).toBe(false);
    expect(ledger.holds.has('a')).toBe(true);
  });

  it('a retry ends everything the task was owed', () => {
    const { ledger } = ledgerOf();
    ledger.oweRepair('a');
    ledger.keepResume('a');
    ledger.oweReopen('a', REOPEN);
    ledger.keepChild('a', 'kept');
    ledger.retried('a');
    expect(ledger.pendingUnasked()).toBe(false);
    expect(ledger.claimed('a')).toBeNull();
    expect(ledger.keptChildren).toEqual([]);
    expect(ledger.holds.has('a')).toBe(false);
  });

  it('a move off the limited runner ends its kept resume, not its repair', () => {
    const { ledger } = ledgerOf();
    ledger.oweRepair('a');
    ledger.keepResume('a');
    ledger.moved('a');
    expect(ledger.owesRepair('a')).toBe(true);
    ledger.cancelled('a');
    expect(ledger.pendingUnasked()).toBe(false);
  });

  it('a new round ends the queued start, not a repair', () => {
    const { ledger } = ledgerOf();
    ledger.queue('a', AT_GATE);
    ledger.oweRepair('a');
    ledger.roundStarted('a');
    expect(ledger.queued.has('a')).toBe(false);
    expect(ledger.owesRepair('a')).toBe(true);
  });

  it.each(['completed', 'skipped'] as const)('%s ends what is owed a start, and keeps a reopen and a kept child', (event) => {
    const { ledger } = ledgerOf();
    ledger.queue('a', AT_GATE);
    ledger.oweRepair('a');
    ledger.keepResume('a');
    ledger.oweReopen('a', REOPEN);
    ledger.keepChild('a', 'kept');
    ledger[event]('a');
    expect(ledger.pendingUnasked()).toBe(false);
    expect(ledger.keptChildren).toEqual(['a']);
    expect(ledger.claimed('a')).toEqual(REOPEN);
  });

  it('leaving the plan ends everything kept for the task, the reopen and the kept child too', () => {
    const { ledger } = ledgerOf();
    ledger.queue('a', AT_GATE);
    ledger.oweRepair('a');
    ledger.keepResume('a');
    ledger.oweReopen('a', REOPEN);
    ledger.keepChild('a', 'kept');
    ledger.left('a');
    expect(ledger.pendingUnasked()).toBe(false);
    expect(ledger.keptChildren).toEqual([]);
    expect(ledger.claimed('a')).toBeNull();
  });

  it('a user\'s Stop withdraws everything owed; a restart keeps the queued starts, the reopens and the kept children', () => {
    const fill = (ledger: StartLedger<string>) => {
      ledger.queue('q', AT_GATE);
      ledger.oweRepair('r');
      ledger.keepResume('k');
      ledger.oweReopen('o', REOPEN);
      ledger.keepChild('c', 'kept');
    };
    const restarted = ledgerOf().ledger;
    fill(restarted);
    restarted.stopped('restart');
    expect(restarted.owesRepairs).toBe(false);
    expect(restarted.pendingUnasked(() => false)).toBe(false);
    expect(restarted.queued.has('q')).toBe(true);
    expect(restarted.keptChildren).toEqual(['c']);
    expect(restarted.claimed('o')).toEqual(REOPEN);

    const stopped = ledgerOf().ledger;
    fill(stopped);
    stopped.stopped('user');
    expect(stopped.pendingUnasked()).toBe(false);
    expect(stopped.keptChildren).toEqual([]);
    expect(stopped.claimed('o')).toBeNull();
  });

  it('a plan loaded ends repairs and resumes; an edit keeps the queued starts of tasks it still has, another plan none', () => {
    const { ledger } = ledgerOf();
    ledger.queue('kept', AT_GATE);
    ledger.queue('gone', AT_GATE);
    ledger.oweRepair('r');
    ledger.keepResume('k');
    ledger.oweReopen('o', REOPEN);
    ledger.planLoaded(planOf((id) => id !== 'gone'), { keepsChosen: true, edited: true });
    expect(ledger.queued.has('kept')).toBe(true);
    expect(ledger.queued.has('gone')).toBe(false);
    expect(ledger.pendingUnasked(() => false)).toBe(false);
    expect(ledger.claimed('o')).toEqual(REOPEN);

    ledger.planLoaded(planOf(() => true), { keepsChosen: true, edited: false });
    expect(ledger.queued.has('kept')).toBe(false);
  });
});

describe('StartLedger offer', () => {
  it('offers the queued starts, then the repairs with the admission, then the resumes', async () => {
    const { ledger, offered } = ledgerOf();
    ledger.keepResume('k');
    ledger.oweRepair('r');
    ledger.queue('q', AT_GATE);
    await ledger.offer('now');
    expect(offered).toEqual(['queued:q', 'repair:r@now', 'resume:k']);
  });

  it('keeps an owed start that waits or finds no slot, and ends one that ends or starts', async () => {
    const started: string[] = [];
    const { ledger } = ledgerOf({
      queued: { full: 'full', ends: 'ends', go: { start: async () => { started.push('go'); } } },
      repair: { ends: 'ends', go: { start: () => started.push('repair') } },
      resume: { ends: 'ends', go: { start: () => started.push('resume') } },
    });
    for (const id of ['waits', 'full', 'ends', 'go']) ledger.queue(id, AT_GATE);
    for (const id of ['waits', 'ends', 'go']) ledger.oweRepair(id);
    for (const id of ['ends', 'go']) ledger.keepResume(id);
    await ledger.offer('now');
    expect(started).toEqual(['go', 'repair', 'resume']);
    expect(['waits', 'full', 'ends', 'go'].filter((id) => ledger.queued.has(id))).toEqual(['waits', 'full']);
    expect(['waits', 'ends', 'go'].filter((id) => ledger.owesRepair(id))).toEqual(['waits']);
    ledger.cancelled('waits');
    expect(ledger.pendingUnasked(() => false)).toBe(false);
  });

  it('a repair or a resume that finds no slot leaves every one after it of its kind owed, unoffered', async () => {
    const { ledger, offered } = ledgerOf({ repair: { a: 'full' }, resume: { a: 'full' } });
    ledger.oweRepair('a');
    ledger.oweRepair('b');
    ledger.keepResume('a');
    ledger.keepResume('b');
    await ledger.offer('now');
    expect(offered).toEqual(['repair:a@now', 'resume:a']);
    expect(ledger.owesRepair('b')).toBe(true);
  });

  it('a queued start that finds no slot does not stop the ones after it: each is judged on its own', async () => {
    const { ledger, offered } = ledgerOf({ queued: { a: 'full' } });
    ledger.queue('a', AT_GATE);
    ledger.queue('b', AT_GATE);
    await ledger.offer('now');
    expect(offered).toEqual(['queued:a', 'queued:b']);
  });

  it('takes a queued start out of the queue before making it, so the start may queue it again', async () => {
    const again: QueuedStart = { pastGate: ['x'] };
    const { stub } = claimant();
    const ledger: StartLedger<string> = new StartLedger<string>({ ...stub, queued: () => ({ start: async () => ledger.queue('a', again) }) });
    ledger.queue('a', AT_GATE);
    await ledger.offer('now');
    expect(ledger.queued.has('a')).toBe(true);
  });

  it('does not offer what a path ended while an earlier start was being made, as a Stop does', async () => {
    const { stub, offered } = claimant();
    const ledger: StartLedger<string> = new StartLedger<string>({
      ...stub,
      queued: (id, start) => (id === 'a' ? { start: async () => ledger.stopped('user') } : stub.queued(id, start)),
      repair: (id, admission) => (id === 'r1' ? { start: () => ledger.cancelled('r2') } : stub.repair(id, admission)),
      resume: (id) => (id === 'k1' ? { start: () => ledger.left('k2') } : stub.resume(id)),
    });
    ledger.queue('a', AT_GATE);
    ledger.queue('b', AT_GATE);
    await ledger.offer('now');
    expect(offered).toEqual([]);
    expect(ledger.queued.has('b')).toBe(false);

    ledger.oweRepair('r1');
    ledger.oweRepair('r2');
    ledger.keepResume('k1');
    ledger.keepResume('k2');
    await ledger.offer('now');
    expect(offered).toEqual([]);
    expect(ledger.pendingUnasked()).toBe(false);
  });

  it('leaves a queued start queued again since the drain began to the next drain, which judges it as it now stands', async () => {
    const replaced: QueuedStart = { pastGate: ['x'] };
    const seen: QueuedStart[] = [];
    const ledger: StartLedger<string> = new StartLedger<string>({
      queued: (id, start) => {
        seen.push(start);
        if (id === 'a') return { start: async () => ledger.queue('b', replaced) };
        return 'waits';
      },
      repair: () => 'waits',
      resume: () => 'waits',
    });
    ledger.queue('a', AT_GATE);
    ledger.queue('b', AT_GATE);
    await ledger.offer('now');
    expect(seen).toEqual([AT_GATE]);
    expect(ledger.queued.has('b')).toBe(true);
  });

  it('awaits each queued start before offering the next', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = vi.fn((id: string): Offer<() => Promise<void>> => (id === 'a' ? { start: () => gate } : 'waits'));
    const ledger: StartLedger<string> = new StartLedger<string>({ queued, repair: () => 'waits', resume: () => 'waits' });
    ledger.queue('a', AT_GATE);
    ledger.queue('b', AT_GATE);
    const drained = ledger.offer('now');
    await Promise.resolve();
    expect(queued).toHaveBeenCalledTimes(1);
    release();
    await drained;
    expect(queued).toHaveBeenCalledTimes(2);
  });
});

describe('StartLedger carried work', () => {
  it('carries nothing at first', () => {
    const { ledger } = ledgerOf();
    expect(ledger.carried(ALL_OWED)).toEqual([]);
    expect(ledger.carriesCheck('c')).toBe(false);
  });

  it('lists the carried checks that the reader counts as owed now', () => {
    const { ledger } = ledgerOf();
    ledger.carryCheck('c1');
    ledger.carryCheck('c2');
    expect(ledger.carried(ALL_OWED)).toEqual(['c1', 'c2']);
    expect(ledger.carried((id) => id === 'c1')).toEqual(['c1']);
    // Counted as owed or not, each stays carried.
    expect(ledger.carriesCheck('c2')).toBe(true);
  });

  it('carries a task once however often it is carried', () => {
    const { ledger } = ledgerOf();
    ledger.carryCheck('c');
    ledger.carryCheck('c');
    expect(ledger.carried(ALL_OWED)).toEqual(['c']);
  });

  it('a claim starts a carried check', () => {
    const { ledger } = ledgerOf();
    ledger.carryCheck('a');
    ledger.carryCheck('b');
    expect(ledger.claimed('a')).toBeNull();
    expect(ledger.carriesCheck('a')).toBe(false);
    expect(ledger.carriesCheck('b')).toBe(true);
  });

  it('the run ending ends everything it carried, and owes no start it owed', () => {
    const { ledger } = ledgerOf();
    ledger.carryCheck('c');
    ledger.oweRepair('r');
    ledger.queue('q', AT_GATE);
    ledger.runEnded();
    expect(ledger.carried(ALL_OWED)).toEqual([]);
    expect(ledger.owesRepair('r')).toBe(true);
    expect(ledger.queued.has('q')).toBe(true);
  });

  it.each(['user', 'restart'] as const)('a %s stop ends everything carried', (reason) => {
    const { ledger } = ledgerOf();
    ledger.carryCheck('c');
    ledger.stopped(reason);
    expect(ledger.carried(ALL_OWED)).toEqual([]);
  });

  it('an edit keeps a check still in the plan; another plan keeps none', () => {
    const { ledger } = ledgerOf();
    for (const id of ['kept', 'gone']) ledger.carryCheck(id);
    ledger.planLoaded(planOf((id) => id !== 'gone'), { keepsChosen: true, edited: true });
    expect(ledger.carried(ALL_OWED)).toEqual(['kept']);

    ledger.planLoaded(planOf(() => true), { keepsChosen: true, edited: false });
    expect(ledger.carried(ALL_OWED)).toEqual([]);
  });

  it('a carried check counts as no owed start: the drain does not offer it, and pendingUnasked does not count it', async () => {
    const { ledger, offered } = ledgerOf();
    ledger.carryCheck('c');
    await ledger.offer('now');
    expect(offered).toEqual([]);
    expect(ledger.pendingUnasked()).toBe(false);
  });

  it('the events of a task\'s other entries leave what it carries', () => {
    const { ledger } = ledgerOf();
    ledger.carryCheck('a');
    for (const event of RELEASES) ledger[event]('a');
    ledger.cancelled('a');
    ledger.forcedNow('a');
    expect(ledger.carriesCheck('a')).toBe(true);
  });
});
