import { describe, it, expect, vi, afterEach } from 'vitest';
import { EMPTY_TASK_LOG_FOLLOW, type TaskLogFollow } from '../../conversation/taskLogFollow';
import { EMPTY_TASK_LOG, type TaskLogView } from '../../conversation/taskLog';
import type { AttemptUsage } from '../../models/Usage';
import { logContinues, logResumes, taskLogCommands, taskLogHeaderView, type TaskLogHeaderTask } from '..';

const task = (over: Partial<TaskLogHeaderTask> = {}): TaskLogHeaderTask => ({ status: 'in_progress', ...over });
const logView = (over: Partial<TaskLogView> = {}): TaskLogView => ({ ...EMPTY_TASK_LOG, ...over });
const follow = (over: Partial<TaskLogFollow> = {}): TaskLogFollow => ({ ...EMPTY_TASK_LOG_FOLLOW, ...over });
const header = (over: Partial<TaskLogHeaderTask> = {}, viewOver: Partial<TaskLogView> = {}, approvals = 0, attempt = 1) =>
  taskLogHeaderView(task(over), follow({ view: logView(viewOver), attempt }), approvals, attempt);

const attempt = (n: number, over: Partial<AttemptUsage> = {}): AttemptUsage => ({
  attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 0, totals: { inputTokens: 1000 }, byModel: [], ...over,
});
const measured = (cost: number, used: number, window = 200_000): Partial<AttemptUsage> => ({
  totals: { reportedCost: { USD: cost } }, lastPromptTokens: used, contextWindow: window,
});

afterEach(() => vi.useRealTimers());

describe('what a task log header says the task is doing (ADR-0018, V1)', () => {
  it.each([
    ['completed', {}, 'done', 'Done'],
    ['failed', {}, 'failed', 'Failed'],
    ['skipped', {}, 'skipped', 'Skipped'],
    ['skipped', { skipReason: 'no GPU on this host' }, 'skipped', 'Skipped: no GPU on this host'],
    ['blocked', {}, 'blocked', 'Blocked'],
    ['pending', {}, 'todo', 'To do'],
    ['approved', {}, 'todo', 'To do'],
    ['in_progress', {}, 'running', 'Running'],
    ['in_progress', { idleSince: '2026-10-24T12:00:00Z' }, 'quiet', 'Stalled'],
    ['awaiting_user', {}, 'awaiting', 'Waiting for your input'],
    ['awaiting_user', { awaitingReason: 'input' }, 'awaiting', 'Waiting for your input'],
    ['awaiting_user', { awaitingReason: 'checkpoint' }, 'checkpoint', 'Checkpoint'],
    ['awaiting_user', { awaitingReason: 'conflict' }, 'awaiting', 'Merge conflict'],
    ['awaiting_user', { awaitingReason: 'files-changed' }, 'awaiting', 'Changed tracked files'],
    ['awaiting_user', { awaitingReason: 'usage-limit' }, 'awaiting', 'Paused on a usage limit'],
  ] as const)('a %s task reads "%s"', (status, over, kind, label) => {
    expect(header({ status, ...over }).state).toEqual({ kind, label });
  });

  it('a live turn reads as Working while the store still says in_progress', () => {
    expect(header({ status: 'in_progress' }, { working: true }).state).toEqual({ kind: 'running', label: 'Working' });
    expect(header({ status: 'awaiting_user', awaitingReason: 'input' }, { working: true }).state.label).toBe('Working');
  });

  it('a settled task wins over a stale live turn and a waiting request', () => {
    expect(header({ status: 'completed' }, { working: true }, 2).state).toEqual({ kind: 'done', label: 'Done' });
    expect(header({ status: 'failed' }, { working: true }, 1).state).toEqual({ kind: 'failed', label: 'Failed' });
    expect(header({ status: 'skipped' }, { working: true }, 1).state.label).toBe('Skipped');
  });

  it('a runner request waiting for an answer wins over the live turn it stopped (A1)', () => {
    expect(header({}, { working: true }, 1).state).toEqual({ kind: 'approval', label: 'Waiting for approval' });
    expect(header({}, { working: true }, 3).state.label).toBe('Waiting for approval (3)');
  });

  it('words a turn that failed or was stopped while the task stayed in_progress', () => {
    expect(header({ status: 'in_progress' }, { lastTurnEnd: 'failed' }).state).toEqual({ kind: 'failed', label: 'Turn failed' });
    expect(header({ status: 'in_progress' }, { lastTurnEnd: 'interrupted' }).state).toEqual({ kind: 'todo', label: 'Interrupted' });
  });

  it('lets the saved status speak once a turn ended well', () => {
    expect(header({ status: 'in_progress' }, { lastTurnEnd: 'completed' }).state).toEqual({ kind: 'running', label: 'Running' });
  });
});

describe('the log header resume time', () => {
  it('says when a task paused on a usage limit resumes on its own', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00'));
    const resumed = header({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: new Date('2026-10-24T20:10:00').toISOString() });
    expect(resumed.resumes).toBe('Resumes at 8:10pm');
  });

  it('says nothing for a pause with no reset time, or any other wait', () => {
    expect(header({ status: 'awaiting_user', awaitingReason: 'usage-limit' }).resumes).toBeNull();
    expect(header({ status: 'awaiting_user', awaitingReason: 'input', resumeAt: new Date('2026-10-24T20:10:00').toISOString() }).resumes).toBeNull();
    expect(header({ status: 'in_progress', resumeAt: new Date('2026-10-24T20:10:00').toISOString() }).resumes).toBeNull();
  });
});

describe('whether the composer continues the task (ADR-0018, K1)', () => {
  it.each(['completed', 'failed', 'skipped'] as const)('a %s task with a saved session is continued', (status) => {
    expect(logContinues({ status, continuable: true })).toBe(true);
    expect(logResumes({ status, continuable: true })).toBe(false);
  });

  it('a task paused on a usage limit is resumed now', () => {
    const paused = { status: 'awaiting_user', awaitingReason: 'usage-limit' as const, continuable: true };
    expect(logContinues(paused)).toBe(true);
    expect(logResumes(paused)).toBe(true);
  });

  it('a delegated task a Stop left, or whose question a restart lost, is continued: its child is still there (ADR-0055 D17)', () => {
    expect(logContinues({ type: 'delegated', status: 'pending', continuable: true })).toBe(true);
    expect(logContinues({ type: 'delegated', status: 'awaiting_user', awaitingReason: 'question-lost', continuable: true })).toBe(true);
    expect(logContinues({ type: 'delegated', status: 'awaiting_user', awaitingReason: 'checkpoint', continuable: true })).toBe(false);
  });

  it('no saved session, or a status that cannot continue, offers neither', () => {
    expect(logContinues({ status: 'pending', continuable: true })).toBe(false);
    expect(logContinues({ status: 'completed' })).toBe(false);
    expect(logContinues({ status: 'completed', continuable: false })).toBe(false);
    expect(logContinues({ status: 'in_progress', continuable: true })).toBe(false);
    expect(logContinues({ status: 'awaiting_user', awaitingReason: 'input', continuable: true })).toBe(false);
    expect(logResumes({ status: 'awaiting_user', awaitingReason: 'usage-limit' })).toBe(false);
  });

  it('the view reports both flags', () => {
    expect(header({ status: 'completed', continuable: true })).toMatchObject({ continuable: true, resumable: false });
    expect(header({ status: 'awaiting_user', awaitingReason: 'usage-limit', continuable: true })).toMatchObject({ continuable: true, resumable: true });
  });
});

describe('the log header usage line', () => {
  it('draws the latest attempt as the task total, meter and cost together', () => {
    const rows = header({ attemptUsage: [attempt(1, measured(0.5, 36_000))] }).usage;
    expect(rows).toEqual([{ text: 'ctx 36k (18%) · $0.50', contextFill: { usedTokens: 36_000, windowTokens: 200_000 } }]);
  });

  it('sums every attempt on the latest one, with the meter of its last attempt', () => {
    const rows = header({ attemptUsage: [attempt(1, measured(1, 10_000)), attempt(2, measured(0.5, 100_000))] }, {}, 0, 2).usage;
    expect(rows.map((r) => r.text)).toEqual(['ctx 100k (50%) · $1.50']);
  });

  it("puts a past attempt's own numbers over the task total", () => {
    const rows = header({ attemptUsage: [attempt(1, measured(1, 36_000)), attempt(2, measured(0.5, 100_000))] }, {}, 0, 1).usage;
    expect(rows.map((r) => r.text)).toEqual(['attempt 1: ctx 36k (18%) · $1.00', 'task total: ctx 100k (50%) · $1.50']);
    expect(rows[0]?.contextFill).toEqual({ usedTokens: 36_000, windowTokens: 200_000 });
    expect(rows[1]?.contextFill).toEqual({ usedTokens: 100_000, windowTokens: 200_000 });
  });

  it('reads the latest attempt when no attempt is on screen yet', () => {
    expect(header({ attemptUsage: [attempt(1, measured(1, 36_000)), attempt(2, measured(0.5, 100_000))] }, {}, 0, 0).usage.map((r) => r.text))
      .toEqual(['ctx 100k (50%) · $1.50']);
  });

  it("stands a saved log's own usage in for the past attempt it cannot identify", () => {
    const blocks = [{ type: 'usage' as const, id: 'u', totals: { inputTokens: 500, outputTokens: 40 }, contextFill: { usedTokens: 500 } }];
    const rows = header({ attemptUsage: [attempt(1, measured(1, 36_000)), attempt(2, measured(0.5, 100_000))] }, { blocks }, 0, 3).usage;
    expect(rows.map((r) => r.text)).toEqual(['ctx 500', 'task total: ctx 100k (50%) · $1.50']);
  });

  it('falls back to the log when no attempt ledger was saved', () => {
    const blocks = [{ type: 'usage' as const, id: 'u', totals: { inputTokens: 12_400, outputTokens: 3_100 }, contextFill: { usedTokens: 12_400 } }];
    expect(header({}, { blocks }).usage.map((r) => r.text)).toEqual(['ctx 12k']);
    expect(header({}).usage).toEqual([]);
  });

  it('says nothing when nothing was measured', () => {
    expect(header({ attemptUsage: [attempt(1, { totals: {} })] }).usage).toEqual([]);
    expect(header({ attemptUsage: [attempt(1, { totals: {} })] }, {}, 0, 1).usage).toEqual([]);
  });

  it('draws a reported cost with no meter to show', () => {
    const blocks = [{ type: 'usage' as const, id: 'u', totals: { reportedCost: { USD: 0.5 } } }];
    expect(header({}, { blocks }).usage).toEqual([{ text: '$0.50' }]);
    expect(header({ attemptUsage: [attempt(1, { totals: { reportedCost: { USD: 0.5 } } })] }).usage).toEqual([{ text: '$0.50' }]);
    expect(header({ attemptUsage: [attempt(1, { totals: { reportedCost: { USD: 0.5 } } })] }, {}, 0, 0).usage).toEqual([{ text: '$0.50' }]);
  });

  it('says nothing before an attempt is chosen, and reads the log there', () => {
    expect(header({}, {}, 0, 0).usage).toEqual([]);
    expect(header({ attemptUsage: [attempt(1, { totals: {} })] }, {}, 0, 0).usage).toEqual([]);
    const blocks = [{ type: 'usage' as const, id: 'u', totals: { inputTokens: 500 }, contextFill: { usedTokens: 500 } }];
    expect(header({}, { blocks }, 0, 0).usage.map((r) => r.text)).toEqual(['ctx 500']);
  });

  it('leaves out a log usage block that says nothing', () => {
    const blocks = [{ type: 'usage' as const, id: 'u', totals: {} }];
    expect(header({}, { blocks }).usage).toEqual([]);
  });

  it('draws a past attempt with no meter and no total of its own', () => {
    const rows = header({ attemptUsage: [attempt(1, { totals: {} }), attempt(2)] }, {}, 0, 1).usage;
    expect(rows).toEqual([]);
  });

  it('carries a cost-only past attempt and a cost-only total', () => {
    const rows = header({ attemptUsage: [attempt(1, { totals: { reportedCost: { USD: 0.5 } } }), attempt(2)] }, {}, 0, 1).usage;
    expect(rows).toEqual([{ text: 'attempt 1: $0.50' }, { text: 'task total: $0.50' }]);
  });
});

describe('the log header commands', () => {
  const command = { name: 'compact', kind: 'builtin' as const, description: 'Compact native context' };

  it("reads the attempt on screen's last reported commands (#66)", () => {
    const blocks = [
      { type: 'runner_loaded' as const, id: 'r1', commands: [{ ...command, name: 'old' }], mcpServers: [] },
      { type: 'runner_loaded' as const, id: 'r2', commands: [command], mcpServers: [] },
      { type: 'message' as const, id: 'm', role: 'agent' as const, text: 'after', streaming: false },
    ];
    expect(taskLogCommands({ blocks })).toEqual([command]);
    expect(header({}, { blocks }).commands).toEqual([command]);
  });

  it('reports none when the runner loaded none', () => {
    expect(taskLogCommands({ blocks: [] })).toEqual([]);
  });
});
