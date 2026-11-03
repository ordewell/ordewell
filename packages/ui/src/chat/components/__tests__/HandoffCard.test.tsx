import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HandoffCard from '../HandoffCard';
import type { IsolationMergeResult } from '@ordewell/core';

const landed = [
  { taskId: 't2', order: 2, title: 'Second task' },
  { taskId: 't1', order: 1, title: 'First task' },
];

const handoff = {
  repos: [{ path: '.', integrationBranch: 'ordewell/run-1/integration', baseRef: 'abcdef0123456789', landed }],
  landed,
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

describe('HandoffCard — deferred to the supervisor', () => {
  it('says the supervisor may merge this when it wakes, and keeps every action', () => {
    const onAction = vi.fn();
    render(<HandoffCard {...handoff} deferredTo="supervisor" onAction={onAction} />);

    expect(screen.getByText(/supervisor may merge this when it wakes/i)).toBeTruthy();
    fireEvent.click(screen.getByText('Merge'));
    expect(onAction).toHaveBeenCalledWith('merge');
    for (const label of ['Review diff', 'Clean up', 'Discard']) expect(screen.getByText(label)).toBeTruthy();
  });

  it('has no such note on an unmarked handoff', () => {
    render(<HandoffCard {...handoff} onAction={vi.fn()} />);

    expect(screen.queryByText(/supervisor/i)).toBeNull();
  });
});

describe('HandoffCard — conflict repair (ADR-0015)', () => {
  it('marks a landed task that only landed after repairing a conflict, and its files', () => {
    const repaired = {
      repos: handoff.repos,
      landed: [{ taskId: 't1', order: 1, title: 'First task', repairedFiles: ['a.ts', 'b.ts'] }, handoff.landed[0]],
    };
    render(<HandoffCard {...repaired} onAction={vi.fn()} />);

    const items = [...document.querySelectorAll('.isolation-handoff-landed li')];
    expect(items[0].textContent).toContain('repaired (a.ts, b.ts)');
    expect(items[1].textContent).not.toContain('repaired');
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

  it('treats a one-repo workspace that is not the root as a group, as core does', () => {
    const oneNested = {
      repos: [{ path: 'api', integrationBranch: 'ordewell/run-1/integration', baseRef: 'aaaa11112222', landed: [{ taskId: 't1', order: 1, title: 'Add rate limiting' }] }],
      landed: [{ taskId: 't1', order: 1, title: 'Add rate limiting' }],
    };
    render(<HandoffCard {...oneNested} onAction={vi.fn()} />);

    expect(screen.getByText('Merge all')).toBeTruthy();
    expect(document.querySelector('.isolation-handoff-repo-path')!.textContent).toBe('api');
  });

  it('shows every blocking repository, its reason and files, in core\'s words', () => {
    const blocked: IsolationMergeResult = {
      outcome: 'blocked',
      blocked: [
        { repo: 'api', reason: 'conflict', files: ['src/a.ts'] },
        { repo: 'web', reason: 'uncommitted-changes', files: ['src/b.ts'] },
      ],
    };
    render(<HandoffCard {...groupHandoff} mergeResult={blocked} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merged nothing, so every tree is as it was: api would conflict in src/a.ts; web has uncommitted changes to src/b.ts. Each repository\'s ordewell/run-1/integration is a plain branch you can merge by hand.',
    );
  });

  it('words a git failure as core does', () => {
    const blocked: IsolationMergeResult = { outcome: 'blocked', blocked: [{ repo: 'api', reason: 'git-error', files: [] }] };
    render(<HandoffCard {...groupHandoff} mergeResult={blocked} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merged nothing, so every tree is as it was: git could not check api. Each repository\'s ordewell/run-1/integration is a plain branch you can merge by hand.',
    );
  });

  it('names the repos that landed when a merge stopped part-way', () => {
    const partial: IsolationMergeResult = { outcome: 'conflict', repo: 'web', files: ['src/b.ts'], landed: ['api'] };
    render(<HandoffCard {...groupHandoff} mergeResult={partial} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merging ordewell/run-1/integration conflicted in web (src/b.ts), so it was aborted there. api was merged already and stays merged. Each repository\'s ordewell/run-1/integration is a plain branch you can merge by hand.',
    );
  });

  it('draws a lone repo\'s blocked merge all, not just a group\'s', () => {
    const blocked: IsolationMergeResult = {
      outcome: 'blocked',
      blocked: [{ repo: '.', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
    };
    render(<HandoffCard {...handoff} mergeResult={blocked} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merged nothing, so every tree is as it was: your checkout is on feature-x; this run started on main. Check out main and press Merge all again.',
    );
  });

  it('draws a lone repo\'s clean merge in the lone-repo wording', () => {
    render(<HandoffCard {...handoff} mergeResult={{ outcome: 'merged' }} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merged ordewell/run-1/integration into your checked-out branch.',
    );
  });

  it('tells a lone repo whose merge conflicted to resolve it with git', () => {
    const conflict: IsolationMergeResult = { outcome: 'conflict', repo: '.', files: ['src/a.ts'] };
    render(<HandoffCard {...handoff} mergeResult={conflict} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merging ordewell/run-1/integration conflicted, so it was aborted: your tree is as it was. Merge it with git and resolve the conflict there.',
    );
  });
});

describe('HandoffCard — the branch the run started on', () => {
  const lone = (baseBranch?: string, startedDetached = baseBranch === undefined) => ({
    ...handoff,
    repos: [{ ...handoff.repos[0], ...(baseBranch ? { baseBranch } : {}), ...(startedDetached ? { startedDetached: true as const } : {}) }],
  });

  it('names the branch and commit a lone repo landed on top of', () => {
    render(<HandoffCard {...lone('main')} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-handoff-base')!.textContent).toBe('2 tasks landed on top of main @ abcdef012345');
  });

  it('calls a run that started on a detached HEAD that', () => {
    render(<HandoffCard {...lone()} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-handoff-base')!.textContent).toBe('2 tasks landed on top of detached at abcdef012345');
  });

  it('does not call a record that never noted its branch detached', () => {
    render(<HandoffCard {...lone(undefined, false)} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-handoff-base')!.textContent).toBe('2 tasks landed on top of base abcdef012345');
  });

  it('names it per repository for a group', () => {
    const group = { ...groupHandoff, repos: [{ ...groupHandoff.repos[0], baseBranch: 'main' }, { ...groupHandoff.repos[1], startedDetached: true as const }] };
    render(<HandoffCard {...group} onAction={vi.fn()} />);

    const bases = [...document.querySelectorAll('.isolation-handoff-repo-base')].map((el) => el.textContent);
    expect(bases).toEqual(['on main @ aaaa11112222', 'on detached at bbbb33334444']);
  });

  it('says to finish or abort the rebase of a repository in the middle of one', () => {
    const blocked: IsolationMergeResult = {
      outcome: 'blocked',
      blocked: [{ repo: 'api', reason: 'wrong-branch', files: [], expected: 'main', rebasing: true }],
    };
    render(<HandoffCard {...groupHandoff} mergeResult={blocked} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merged nothing, so every tree is as it was: api is in the middle of a rebase; this run started on main. Finish or abort the rebase in api, then press Merge all again. Each repository\'s ordewell/run-1/integration is a plain branch you can merge by hand.',
    );
  });

  it('says which branch to check out when a repository is on another', () => {
    const blocked: IsolationMergeResult = {
      outcome: 'blocked',
      blocked: [{ repo: 'api', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
    };
    render(<HandoffCard {...groupHandoff} mergeResult={blocked} onAction={vi.fn()} />);

    expect(document.querySelector('.isolation-merge-result')!.textContent).toBe(
      'Merged nothing, so every tree is as it was: api is on feature-x; this run started on main. Check out main and press Merge all again. Each repository\'s ordewell/run-1/integration is a plain branch you can merge by hand.',
    );
  });
});
