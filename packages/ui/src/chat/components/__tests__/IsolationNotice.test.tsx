import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { IsolationPreview, PreviewRepo } from '@ordewell/core';
import EmptyState from '../EmptyState';
import GetStarted from '../GetStarted';

const on = (path: string, branch: string, extra: Partial<PreviewRepo> = {}): PreviewRepo => ({ path, head: { kind: 'branch', branch, commit: 'a1b2c3d' }, dirty: false, ...extra });
const preview = (status: IsolationPreview['status'], repos: PreviewRepo[] = [], extra: Partial<IsolationPreview> = {}): IsolationPreview => ({ status, repos, shared: [], ...extra });

const notice = (container: HTMLElement) => container.querySelector('.isolation-notice');
// A row reads name → head → commit → flag, the parts the card sets apart.
const rows = (container: HTMLElement) => [...container.querySelectorAll('.isolation-repo')].map((r) => {
  const part = (sel: string) => r.querySelector(sel)?.textContent ?? '';
  return [part('.isolation-repo-name'), part('.isolation-repo-head'), part('.isolation-repo-commit'), part('.isolation-repo-flag')]
    .filter(Boolean).join(' ');
});

/** Both first screens draw the one notice, so the user reads the same words whichever they land on. */
describe.each([
  ['EmptyState', (p: IsolationPreview | null | undefined) => <EmptyState isolationPreview={p} />],
  ['GetStarted', (p: IsolationPreview | null | undefined) => <GetStarted runnerNames={[]} onConfigure={vi.fn()} isolationPreview={p} />],
])('%s — repositories and branches', (_name, screen) => {
  it('shows nothing before the host has said anything', () => {
    const { container } = render(screen(undefined));

    expect(notice(container)).toBeNull();
  });

  it('says it is checking, and claims neither a repository nor none, while the host reads', () => {
    const { container } = render(screen(null));

    expect(notice(container)?.textContent).toBe('Checking repositories…');
  });

  it('names the repository and branch, and that code tasks get isolated worktrees', () => {
    const { container } = render(screen(preview('ready', [on('.', 'main')])));

    expect(notice(container)?.textContent).toContain('Code tasks run in isolated git worktrees based on the repositories and branches below.');
    expect(rows(container)).toEqual(['This workspace on main a1b2c3d']);
    expect(notice(container)?.textContent).toContain('Ops and script tasks use your checkout.');
  });

  it('is a card: a title, the summary as a caption, and the commit set apart from its branch', () => {
    const { container } = render(screen(preview('ready', [on('.', 'main')])));
    const card = notice(container)!;
    const repo = card.querySelector('.isolation-repo')!;

    expect(card.querySelector('.isolation-notice-title')?.textContent).toBe('Repositories and branches');
    expect(card.querySelector('.isolation-notice-summary')?.textContent).toContain('Code tasks run in isolated git worktrees');
    expect(repo.querySelector('.isolation-repo-head')?.textContent).toBe('on main');
    expect(repo.querySelector('.isolation-repo-commit')?.textContent).toBe('a1b2c3d');
    // The workspace's one repository is named; a group's are named by path and set in mono.
    expect(repo.querySelector('.isolation-repo-name')?.classList.contains('path')).toBe(false);
    expect(card.querySelector('.isolation-notice-footer .isolation-notice-note')?.textContent).toContain('Ops and script tasks');
  });

  it('sets a group\'s repository paths in the mono face', () => {
    const { container } = render(screen(preview('ready', [on('.', 'main'), on('services/billing', 'feature/x')])));

    expect([...container.querySelectorAll('.isolation-repo-name')].map((n) => n.classList.contains('path')))
      .toEqual([false, true]);
  });

  it('splits only the head shape that carries its commit, and shows an unborn head whole', () => {
    const { container } = render(screen(preview('ready', [on('new', 'main')])));

    expect(rows(container)).toEqual(['new on main a1b2c3d']);
    expect(container.querySelector('.isolation-repo-commit')?.textContent).toBe('a1b2c3d');

    const unborn = render(screen(preview('ready', [{ path: 'new', head: { kind: 'unborn', branch: 'main' } }])));
    expect(unborn.container.querySelector('.isolation-repo-head')?.textContent)
      .toBe('no commits yet on main; tasks share it instead of isolating it');
    expect(unborn.container.querySelector('.isolation-repo-commit')).toBeNull();
  });

  it('lists every repository of a group, however many, each with its own branch', () => {
    const repos = Array.from({ length: 12 }, (_, i) => on(`services/svc-${i}`, i === 3 ? 'feature/x' : 'main'));
    const { container } = render(screen(preview('ready', repos)));

    expect(rows(container)).toHaveLength(12);
    expect(rows(container)[3]).toBe('services/svc-3 on feature/x a1b2c3d');
  });

  it('says tasks run in the workspace without isolated worktrees when no repository is detected', () => {
    const { container } = render(screen(preview('no-repo')));

    expect(notice(container)?.textContent).toContain('No Git repository detected. Tasks run in the workspace without isolated worktrees.');
    expect(rows(container)).toEqual([]);
  });

  it('does not say there is no repository when the read failed', () => {
    const { container } = render(screen(preview('failed', [], { error: 'git did not answer' })));

    expect(notice(container)?.textContent).not.toContain('No Git repository');
    expect(notice(container)?.textContent).toContain("can't say yet");
  });

  it('marks a dirty tree as waiting on the start-time decision, with the dirty repository named', () => {
    const { container } = render(screen(preview('dirty', [on('api', 'main', { dirty: true }), on('web', 'main')])));

    expect(notice(container)?.textContent).toContain('stash them or run without isolation');
    expect(rows(container)[0]).toContain('uncommitted changes');
    expect(rows(container)[1]).not.toContain('uncommitted changes');
  });

  it('says a detached HEAD and a repository with no commits as they are', () => {
    const { container } = render(screen(preview('ready', [
      { path: 'api', head: { kind: 'detached', commit: 'deadbee' }, dirty: false },
      { path: 'new', head: { kind: 'unborn', branch: 'main' } },
    ])));

    expect(rows(container)).toEqual(['api detached HEAD at deadbee', 'new no commits yet on main; tasks share it instead of isolating it']);
  });

  it('is a labelled region, so a screen reader finds it', () => {
    const { container } = render(screen(preview('ready', [on('.', 'main')])));

    expect(notice(container)?.getAttribute('aria-label')).toBe('Repositories and branches');
  });
});
