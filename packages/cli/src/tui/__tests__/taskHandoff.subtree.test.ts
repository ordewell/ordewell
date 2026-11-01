import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMPTY_TASK_LOG_FOLLOW, replayTaskLog, type StoredHandoff, type SubtreeReport, type TaskLogEvent } from '@ordewell/core';
import { stripAnsi, style } from '../ansi';
import { render } from '../render';
import { initialState, type TaskLogState, type TaskView, type TuiState } from '../state';

/*
 * What a delegated task's report adds to its handoff (ADR-0057 R2) in the
 * task view: Ordewell's counts, what the parent must decide, and what the
 * subplanner passed up, each by the reference that names it.
 */

const offered = vi.hoisted(() => ({ value: true }));
vi.mock('@ordewell/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core')>();
  return { ...real, get DELEGATION_OFFERED() { return offered.value; } };
});

beforeAll(() => { style.enabled = false; });
afterAll(() => { style.enabled = true; });

const subtree: SubtreeReport = {
  node: 'root/1',
  counts: { done: 3, failed: 1, blocked: 0, skipped: 0, commits: 3, tokens: 1_204_000 },
  findings: { blocker: 0, major: 1, minor: 1, info: 0 },
  open: [{ ref: { kind: 'task', task: 't9', node: 'root/1', label: '#2 "Write b"', attempt: 1, finding: 'F1' }, finding: { id: 'F1', severity: 'major', title: 'The importer drops dates', detail: 'Seen in two fixtures.' } }],
  promoted: [{ finding: { id: 'F1', severity: 'minor', title: 'A flaky timer' } }],
  outsideScope: { paths: ['docs/a.md'], count: 3 },
};

const handoff: StoredHandoff = { summary: 'Both files are written.', findings: [], findingCount: 0, subtree };

const task = (): TaskView => ({ id: 'd', order: 1, title: 'Import ledger', type: 'delegated', status: 'completed', dependencies: [] });
const log = (events: TaskLogEvent[]): TaskLogState => ({ taskId: 'd', ...EMPTY_TASK_LOG_FOLLOW, view: replayTaskLog(events), attempts: [1], attempt: 1, loaded: true, followLatest: true, queuedIndex: null });
const opened = (events: TaskLogEvent[]): TuiState => initialState({ sessionId: 's1', rows: 50, cols: 200, focus: 'chat', tasks: [task()], taskView: log(events) });
const plain = (state: TuiState): string => render(state).map(stripAnsi).join('\n');

describe('a delegated task\'s handoff in its view', () => {
  it('draws the counts, what is open and what was passed up, and where its branch strayed', () => {
    const out = plain(opened([{ type: 'handoff', handoff }]));

    expect(out).toContain('Subtree: 3 done, 1 failed · 3 commits · 1.2M tokens · 1 major, 1 minor findings below');
    expect(out).toContain('Changed outside its declared scope: docs/a.md (+2 more)');
    expect(out).toContain('Open, for you to decide:');
    expect(out).toContain('F1 · Major · The importer drops dates');
    expect(out).toContain('Seen in two fixtures.');
    expect(out).toContain('1:#2 "Write b"@1/F1');
    expect(out).toContain('Passed up by its subplanner:');
    expect(out).toContain('F1 · Minor · A flaky timer');
  });

  it('draws nothing of it where delegation is not offered', () => {
    offered.value = false;
    try {
      expect(plain(opened([{ type: 'handoff', handoff }]))).not.toMatch(/Subtree:|Open, for you|Passed up/);
    } finally {
      offered.value = true;
    }
  });

  it('draws nothing of it on a handoff that has no subtree', () => {
    const out = plain(opened([{ type: 'handoff', handoff: { summary: 'Done.', findings: [], findingCount: 0 } }]));
    expect(out).not.toMatch(/Subtree:|Open, for you|Passed up/);
  });

  it('leaves an empty list unsaid', () => {
    const quiet = { ...handoff, subtree: { ...subtree, open: [], promoted: [], outsideScope: undefined } };
    const out = plain(opened([{ type: 'handoff', handoff: quiet }]));
    expect(out).toContain('Subtree: ');
    expect(out).not.toMatch(/Open, for you|Passed up|outside its declared scope/);
  });
});
