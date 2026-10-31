import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask } from '../../models/Task';
import { checkHandoff, handoffReferenceText, storedHandoff } from '../../models/Handoff';
import { readTask } from '../readTask';
import { Supervisor, type SupervisorHost } from '../Supervisor';

/**
 * What review #47 confirmed. Each fails against the build it reviewed: a held
 * event restored from a saved plan is never flushed, a pinned reference the
 * plan prints cannot be read where the session holds no logs, and a task's
 * citation of its own current finding is checked against the previous attempt.
 */

describe('a held event comes back on a reload (ADR-0057 R4, ADR-0029)', () => {
  afterEach(() => vi.useRealTimers());

  const held = (taskId: string) => ({ kind: 'task_failed' as const, taskId, at: Date.now() });
  const report = (taskId: string) => ({
    kind: 'task_report' as const, taskId, at: Date.now(), report: { authority: 'supervisor' as const, text: 'its report', passed: false },
  });

  /** A supervisor whose facts say nothing else flushes, so only the cache's 80% age applies: 32ms of a 40ms TTL. */
  function restored() {
    const deliver = vi.fn(async () => undefined);
    const host = {
      run: () => ({ level: 'act' }),
      deliver,
      pump: () => undefined,
      saveState: () => undefined,
      stoppedByUser: () => false,
      digestReader: () => ({ describe: (id: string) => id, blockedBy: () => [] }),
      wakeFacts: () => ({ nothingCanStart: false, cohortDone: new Set<string>(), blocksWork: new Set<string>(), ttlMs: 40, requestAt: null }),
      readBudget: () => 5,
      retryLimit: () => 2,
      restartPlanner: () => undefined,
      abandonTurn: () => undefined,
      goUnsupervised: () => undefined,
      wakeUpEnded: () => undefined,
      dropToWatch: () => undefined,
      notice: () => undefined,
    } as unknown as SupervisorHost;
    return { deliver, sup: new Supervisor(host, { debounceMs: 5 }) };
  }

  it('delivers a failure that was waiting in the saved plan, at its maximum age', async () => {
    vi.useFakeTimers();
    const { deliver, sup } = restored();
    sup.restore({ policy: { attention: [held('t1')], sinceLast: [] }, wakeUps: [] });

    await vi.advanceTimersByTimeAsync(100);

    expect(deliver).toHaveBeenCalled();
    expect(JSON.stringify(deliver.mock.calls)).toContain('t1');
  });

  it('does not leave the failure behind when a report is restored with it', async () => {
    vi.useFakeTimers();
    const { deliver, sup } = restored();
    sup.restore({ policy: { attention: [held('t1'), report('t2')], sinceLast: [] }, wakeUps: [] });

    await vi.advanceTimersByTimeAsync(100);

    const said = JSON.stringify(deliver.mock.calls);
    expect(said).toContain('t1 failed');
  });
});

describe('a pinned reference reads what it names (ADR-0057 R1)', () => {
  const finding = storedHandoff({ summary: 'Found it.', findings: [{ severity: 'major', title: 'The race' }] })!;
  const plan = [
    createTask({ id: 'review', order: 4, title: 'Review', handoff: { ...finding, attempt: 2 } }),
    createTask({ id: 'fix', order: 5, title: 'Fix', dependencies: ['review'] }),
  ];
  // A forked conversation: the plan's digests, and none of the logs behind them.
  const forked = { attempts: () => [] as number[], events: () => [] };

  it('reads the plan\'s digest where the session holds no log of that attempt', () => {
    const text = handoffReferenceText({ kind: 'task', task: 'review', attempt: 2, finding: 'F1' }, (id) => (id === 'review' ? '#4' : undefined));
    expect(text).toBe('#4@2/F1');

    const read = readTask({ task: text }, 'fix', plan, forked);
    expect(read.isError).toBeUndefined();
    expect(read.text).toContain('F1 [major] The race');
  });

  it('says there is no handoff when the attempt asked for is not the one the digest is from', () => {
    const read = readTask({ task: '#4@3' }, 'fix', plan, { attempts: () => [1, 2, 3], events: () => [] });

    expect(read.text).toContain('no handoff from attempt 3 of 3');
    expect(read.text).not.toContain('The race');
  });

  it('still refuses an attempt neither the logs nor the digest hold', () => {
    expect(readTask({ task: '#4@1' }, 'fix', plan, forked)).toMatchObject({ isError: true, text: expect.stringContaining('no saved attempt 1') });
  });
});

describe('a task citing its own finding is checked against the handoff it is writing (ADR-0057 R1)', () => {
  it('takes F3 of the attempt making the call', () => {
    const before = storedHandoff({ summary: 'First look.', findings: [{ severity: 'major', title: 'One' }] })!;
    const tasks = [createTask({ id: 'solo', order: 1, title: 'Solo', handoff: { ...before, attempt: 1 } })];

    const check = checkHandoff({
      summary: 'Second look.',
      findings: [{ severity: 'minor', title: 'A' }, { severity: 'minor', title: 'B' }, { severity: 'blocker', title: 'C' }],
      artifacts: [{ kind: 'task', task: '#1/F3' }],
    }, 'solo', tasks, { attempt: 2, logs: { attempts: () => [1], handoff: () => undefined } });

    expect(check.ok).toBe(true);
    expect(check.ok && check.handoff.artifacts).toEqual([expect.objectContaining({ task: 'solo', attempt: 2, finding: 'F3' })]);
  });

  it('refuses a finding the attempt before had and this handoff does not', () => {
    const before = storedHandoff({ summary: 'First look.', findings: Array.from({ length: 5 }, (_, i) => ({ severity: 'minor' as const, title: `Finding ${i}` })) })!;
    const tasks = [createTask({ id: 'solo', order: 1, title: 'Solo', handoff: { ...before, attempt: 1 } })];

    const check = checkHandoff({
      summary: 'Second look.',
      findings: [{ severity: 'minor', title: 'A' }],
      artifacts: [{ kind: 'task', task: '#1/F5' }],
    }, 'solo', tasks, { attempt: 2, logs: { attempts: () => [1], handoff: () => undefined } });

    expect(check).toMatchObject({ ok: false, refusal: expect.stringContaining('this handoff has F1 to F1') });
  });

  it('takes the attempt making the call when the citation names it outright', () => {
    const tasks = [createTask({ id: 'solo', order: 1, title: 'Solo' })];

    const check = checkHandoff({
      summary: 'A look.',
      findings: [{ severity: 'minor', title: 'A' }],
      artifacts: [{ kind: 'task', task: '#1@2/F1' }],
    }, 'solo', tasks, { attempt: 2, logs: { attempts: () => [1], handoff: () => undefined } });

    expect(check.ok).toBe(true);
  });

  it('checks an earlier attempt it names against that attempt', () => {
    const before = storedHandoff({ summary: 'First look.', findings: [{ severity: 'major', title: 'One' }] })!;
    const tasks = [createTask({ id: 'solo', order: 1, title: 'Solo' })];

    const check = checkHandoff({
      summary: 'Second look.',
      findings: [{ severity: 'minor', title: 'A' }, { severity: 'minor', title: 'B' }],
      artifacts: [{ kind: 'task', task: '#1@1/F2' }],
    }, 'solo', tasks, { attempt: 2, logs: { attempts: () => [1], handoff: () => before } });

    expect(check).toMatchObject({ ok: false, refusal: expect.stringContaining('its attempt 1 has F1 to F1') });
  });
});
