import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StoredHandoff, SubtreeReport } from '@ordewell/core';

/*
 * What a delegated task's report adds to its handoff (ADR-0057 R2): Ordewell's
 * counts, what the parent must decide, and what the subplanner passed up. It
 * shows only where delegation is offered (ADR-0055 D21).
 */

const offered = vi.hoisted(() => ({ value: true }));
vi.mock('@ordewell/core/plan-utils', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ordewell/core/plan-utils')>();
  return { ...real, get DELEGATION_OFFERED() { return offered.value; } };
});

import TaskHandoff from '../TaskHandoff';

const subtree: SubtreeReport = {
  node: 'root/1',
  counts: { done: 3, failed: 1, blocked: 0, skipped: 0, commits: 3, tokens: 1_204_000 },
  findings: { blocker: 0, major: 1, minor: 1, info: 0 },
  open: [{ ref: { kind: 'task', task: 't9', node: 'root/1', label: '#2 "Write b"', attempt: 1, finding: 'F1' }, finding: { id: 'F1', severity: 'major', title: 'The importer drops dates', detail: 'Seen in two fixtures.' } }],
  promoted: [{ finding: { id: 'F1', severity: 'minor', title: 'A flaky timer' } }],
  outsideScope: { paths: ['docs/a.md'], count: 3 },
};
const handoff: StoredHandoff = { summary: 'Both files are written.', findings: [], findingCount: 0, subtree };

beforeEach(() => { offered.value = true; });

describe('a delegated task\'s handoff', () => {
  it('draws the counts, what is open and what was passed up, and where its branch strayed', () => {
    render(<TaskHandoff handoff={handoff} />);
    const section = document.querySelector('.task-handoff-subtree') as HTMLElement;

    expect(section.textContent).toContain('3 done, 1 failed · 3 commits · 1.2M tokens · 1 major, 1 minor findings below');
    expect(section.textContent).toContain('Changed outside its declared scope: docs/a.md (+2 more)');
    expect(screen.getByText('Open, for you to decide')).toBeTruthy();
    expect(screen.getByText('F1 · Major · The importer drops dates')).toBeTruthy();
    expect(screen.getByText('Seen in two fixtures.')).toBeTruthy();
    expect(screen.getByText('1:#2 "Write b"@1/F1')).toBeTruthy();
    expect(screen.getByText('Passed up by its subplanner')).toBeTruthy();
    expect(screen.getByText('F1 · Minor · A flaky timer')).toBeTruthy();
  });

  it('leaves an empty list unsaid', () => {
    render(<TaskHandoff handoff={{ ...handoff, subtree: { ...subtree, open: [], promoted: [], outsideScope: undefined } }} />);
    expect(document.querySelector('.task-handoff-subtree')).not.toBeNull();
    expect(screen.queryByText('Open, for you to decide')).toBeNull();
    expect(screen.queryByText('Passed up by its subplanner')).toBeNull();
  });

  it('draws nothing of it where delegation is not offered, or on a handoff with no subtree', () => {
    offered.value = false;
    const { unmount } = render(<TaskHandoff handoff={handoff} />);
    expect(document.querySelector('.task-handoff-subtree')).toBeNull();
    unmount();
    offered.value = true;
    render(<TaskHandoff handoff={{ summary: 'Done.', findings: [], findingCount: 0 }} />);
    expect(document.querySelector('.task-handoff-subtree')).toBeNull();
  });
});
