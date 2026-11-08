import { describe, it, expect } from 'vitest';
import { serializeTaskStatus } from '../SessionMessage';
import { createTask, type Task } from '../../models/Task';
import type { TaskIsolation } from '../../interfaces/IWorktreeIsolation';
import type { DelegatedRow } from '../../models/Delegation';
import type { QueuedTaskMessage } from '../../interfaces/IRunner';

// `createTask` keeps a narrower override set than `Task`, so the status-gated
// fields are laid on afterwards instead of widening what it accepts.
const task: Task = {
  ...createTask({
    id: 't1',
    type: 'ai',
    title: 'Check',
    status: 'awaiting_user',
    verdict: {
      outcome: 'fail',
      reason: 'a check failed',
      checks: [{ name: 'task_complete', passed: false, skipped: false, detail: 'not called' }],
      decidedAt: '2026-01-02T03:00:00.000Z',
      reported: 'failed',
    },
    attempted: true,
    attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-01-02T02:00:00.000Z', wallTimeMs: 1000, totals: {}, byModel: [] }],
    research: true,
    handoff: { summary: 'done', findings: [], findingCount: 0 },
    loop: { body: ['fix'], maxRounds: 3 },
    loopRound: 2,
  }),
  awaitingReason: 'checkpoint',
  forcedPastGate: ['Setup'],
  runnerSessionId: 'sess-1',
};

const isolation: TaskIsolation = { state: 'active', branch: 'ordewell/t1', worktree: '/tmp/wt', repos: ['app'] };
const queued: QueuedTaskMessage[] = [{ id: 'q1', text: 'queued' }];
const delegation: DelegatedRow = {
  tasks: { completed: 1, running: 2, waiting: 3, pending: 4, failed: 5, skipped: 6 },
  tokens: { budget: 1000, left: 400 },
  stopping: true,
};

/**
 * The shape `serializeTaskStatus` emits is wire data every surface reads, so
 * this pins it whole: a refactor of how the facts reach the function must leave
 * the bytes alone (ADR-0018).
 */
describe('serializeTaskStatus wire shape', () => {
  it('pins a call with only the task', () => {
    expect(serializeTaskStatus(task)).toEqual({
      id: 't1',
      type: 'ai',
      status: 'awaiting_user',
      verdict: {
        outcome: 'fail',
        reason: 'a check failed',
        checks: [{ name: 'task_complete', passed: false, skipped: false, detail: 'not called' }],
        reported: 'failed',
      },
      idleSince: null,
      attempted: true,
      attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-01-02T02:00:00.000Z', wallTimeMs: 1000, totals: {}, byModel: [] }],
      awaitingReason: 'checkpoint',
      forcedPastGate: ['Setup'],
      research: true,
      handoff: { summary: 'done', findings: [], findingCount: 0 },
      loop: { body: ['fix'], maxRounds: 3 },
      loopRound: 2,
    });
  });

  it('pins a fully populated call', () => {
    expect(serializeTaskStatus(task, {
      idleSince: '2026-01-02T03:04:05.000Z',
      isolation,
      queued,
      awaitingApproval: 2,
      mergeGate: ['Setup', 'Build'],
      checkpoint: 'Proceed?',
      waitsForApproval: true,
      holdReason: 'waiting on a person',
      completionReceived: 'failed',
      attaching: 2,
      loopStranded: true,
      delegation,
    })).toEqual({
      id: 't1',
      type: 'ai',
      status: 'awaiting_user',
      verdict: {
        outcome: 'fail',
        reason: 'a check failed',
        checks: [{ name: 'task_complete', passed: false, skipped: false, detail: 'not called' }],
        reported: 'failed',
      },
      idleSince: '2026-01-02T03:04:05.000Z',
      completionReceived: 'failed',
      attaching: 2,
      attempted: true,
      attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-01-02T02:00:00.000Z', wallTimeMs: 1000, totals: {}, byModel: [] }],
      isolation,
      awaitingReason: 'checkpoint',
      checkpoint: 'Proceed?',
      queued,
      awaitingApproval: 2,
      mergeGate: ['Setup', 'Build'],
      forcedPastGate: ['Setup'],
      waitsForApproval: true,
      holdReason: 'waiting on a person',
      loopStranded: true,
      research: true,
      handoff: { summary: 'done', findings: [], findingCount: 0 },
      loop: { body: ['fix'], maxRounds: 3 },
      loopRound: 2,
      delegation,
    });
  });

  it('pins the facts a task\'s status gates', () => {
    expect(serializeTaskStatus({
      ...createTask({ id: 's1', status: 'skipped' }),
      runnerSessionId: 'sess-1',
      skipReason: 'not needed',
    })).toEqual({
      id: 's1',
      type: 'ai',
      status: 'skipped',
      verdict: null,
      idleSince: null,
      skipReason: 'not needed',
      continuable: true,
    });
    expect(serializeTaskStatus({
      ...createTask({ id: 'u1', status: 'awaiting_user' }),
      awaitingReason: 'usage-limit',
      resumeAt: '2026-01-02T04:00:00.000Z',
    })).toEqual({
      id: 'u1',
      type: 'ai',
      status: 'awaiting_user',
      verdict: null,
      idleSince: null,
      awaitingReason: 'usage-limit',
      resumeAt: '2026-01-02T04:00:00.000Z',
    });
  });
});
