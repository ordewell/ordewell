import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HandoffCard from '../HandoffCard';
import type { IsolationMergeResult } from '@ordewell/core';

const handoff = {
  repos: [{ path: '.', integrationBranch: 'ordewell/run-1/integration', baseRef: 'abcdef0123456789' }],
  landed: [
    { taskId: 't2', order: 2, title: 'Second task' },
    { taskId: 't1', order: 1, title: 'First task' },
  ],
};

const groupHandoff = {
  repos: [
    { path: 'api', integrationBranch: 'ordewell/run-1/integration', baseRef: 'aaaa11112222', landed: [{ taskId: 't1', order: 1, title: 'Add rate limiting' }] },
    { path: 'web', integrationBranch: 'ordewell/run-1/integration', baseRef: 'bbbb33334444', landed: [{ taskId: 't1', order: 1, title: 'Add rate limiting' }] },
  ],
  landed: [{ taskId: 't1', order: 1, title: 'Add rate limiting' }],
};

describe('HandoffCard (ADR-0013)', () => {
  it('shows the integration branch and what landed, in plan order', () => {
    render(<HandoffCard {...handoff} onAction={vi.fn()} />);

    expect(screen.getByText('ordewell/run-1/integration')).toBeTruthy();
    expect(screen.getByText(/2 tasks landed/)).toBeTruthy();
    const items = document.querySelectorAll('.isolation-handoff-landed li');
    expect([...items].map((li) => li.textContent)).toEqual(['1First task', '2Second task']);
  });

  it('offers review, merge, clean up and discard', () => {
    render(<HandoffCard {...handoff} onAction={vi.fn()} />);

    for (const label of ['Review diff', 'Merge', 'Clean up', 'Discard']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('routes each action to the host', () => {
    const onAction = vi.fn();
    render(<HandoffCard {...handoff} onAction={onAction} />);

    fireEvent.click(screen.getByText('Review diff'));
    fireEvent.click(screen.getByText('Merge'));
    fireEvent.click(screen.getByText('Clean up'));
    fireEvent.click(screen.getByText('Discard'));

    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['reviewDiff', 'merge', 'cleanup', 'discard']);
  });
});

describe('HandoffCard — repo group (ADR-0014)', () => {
  it('shows one row per repository and offers Merge all', () => {
    render(<HandoffCard {...groupHandoff} onAction={vi.fn()} />);

    const paths = [...document.querySelectorAll('.isolation-handoff-repo-path')].map((el) => el.textContent);
    expect(paths).toEqual(['api', 'web']);
    expect(screen.getByText('Merge all')).toBeTruthy();
    expect(screen.queryByText('Merge')).toBeNull();
  });

  it('posts merge for a group of one, as before', () => {
    render(<HandoffCard {...handoff} onAction={vi.fn()} />);

    expect(screen.getByText('Merge')).toBeTruthy();
    expect(screen.queryByText('Merge all')).toBeNull();
    expect(document.querySelector('.isolation-handoff-repo')).toBeNull();
  });

  it('shows every blocking repository, its reason and files, and how to merge by hand', () => {
    const blocked: IsolationMergeResult = {
      outcome: 'blocked',
      blocked: [
        { repo: 'api', reason: 'conflict', files: ['src/a.ts'] },
        { repo: 'web', reason: 'uncommitted-changes', files: ['src/b.ts'] },
      ],
    };
    render(<HandoffCard {...groupHandoff} mergeResult={blocked} onAction={vi.fn()} />);

    const blocks = [...document.querySelectorAll('.isolation-merge-block')].map((el) => el.textContent);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('api');
    expect(blocks[0]).toContain('conflict');
    expect(blocks[0]).toContain('src/a.ts');
    expect(blocks[1]).toContain('web');
    expect(blocks[1]).toContain('uncommitted');
    expect(blocks[1]).toContain('src/b.ts');
    expect(screen.getByText(/can be merged by hand/)).toBeTruthy();
  });

  it('names the repos that landed when a merge stopped part-way', () => {
    const partial: IsolationMergeResult = { outcome: 'conflict', repo: 'web', files: ['src/b.ts'], landed: ['api'] };
    render(<HandoffCard {...groupHandoff} mergeResult={partial} onAction={vi.fn()} />);

    expect(screen.getByText(/stopped in/)).toBeTruthy();
    expect(screen.getByText(/api.*stay merged/)).toBeTruthy();
  });
});
