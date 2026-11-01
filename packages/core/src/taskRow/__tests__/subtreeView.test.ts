import { describe, it, expect } from 'vitest';
import { subtreeView } from '..';
import type { SubtreeReport } from '../../models/Handoff';

/** What a delegated task's report adds to a handoff (ADR-0057 R2): Ordewell's counts, what the parent must decide, and what the subplanner passed up. */

const report = (over: Partial<SubtreeReport> = {}): SubtreeReport => ({
  node: 'root/1',
  counts: { done: 3, failed: 1, blocked: 0, skipped: 0, commits: 3, tokens: 1_204_000 },
  findings: { blocker: 0, major: 1, minor: 2, info: 0 },
  open: [],
  promoted: [],
  ...over,
});

const item = (id: string, severity: 'major' | 'minor', title: string, extra: Record<string, unknown> = {}) => ({
  ref: { kind: 'task' as const, task: 't9', node: 'root/1', label: '#2 "Write b"', attempt: 1, finding: id },
  finding: { id, severity, title, ...extra },
});

describe('a delegated task\'s report, as a surface says it', () => {
  it('counts what ran, its commits and what it spent, and the findings below by severity', () => {
    expect(subtreeView(report()).summary).toBe('3 done, 1 failed · 3 commits · 1.2M tokens · 1 major, 2 minor findings below');
  });

  it('says nothing of what is zero', () => {
    const quiet = report({ counts: { done: 1, failed: 0, blocked: 0, skipped: 0, commits: 0, tokens: 900 }, findings: { blocker: 0, major: 0, minor: 0, info: 0 } });
    expect(subtreeView(quiet).summary).toBe('1 done · 900 tokens · no findings below');
  });

  it('draws what the parent must decide and what was passed up, each finding by the reference that names it', () => {
    const view = subtreeView(report({
      open: [item('F1', 'major', 'The importer drops dates', { detail: 'Seen in two fixtures.' })],
      promoted: [item('F2', 'minor', 'A flaky timer')],
    }));

    expect(view.open).toEqual([{ reference: '1:#2 "Write b"@1/F1', heading: 'F1 · Major · The importer drops dates', detail: 'Seen in two fixtures.' }]);
    expect(view.promoted).toEqual([{ reference: '1:#2 "Write b"@1/F2', heading: 'F2 · Minor · A flaky timer' }]);
  });

  it('draws a subplanner\'s own finding, which names no task, with its own id', () => {
    const own = { finding: { id: 'F1', severity: 'major' as const, title: 'The plan was wrong' } };
    expect(subtreeView(report({ open: [own] })).open).toEqual([{ reference: null, heading: 'F1 · Major · The plan was wrong' }]);
  });

  it('names what its branch changed outside its scope, the first paths and how many', () => {
    const view = subtreeView(report({ outsideScope: { paths: ['a.ts', 'b.ts'], count: 5 } }));
    expect(view.outsideScope).toBe('Changed outside its declared scope: a.ts, b.ts (+3 more)');
    expect(subtreeView(report()).outsideScope).toBeNull();
  });
});
