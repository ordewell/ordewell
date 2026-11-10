import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MiddleText, SidebarGroup, splitMiddle } from '../sidebarKit';
import { SyncBar, pullBlocked, pushBlocked, type SyncState } from '../git/SyncBar';

const TRACKING: SyncState = { upstream: 'origin/main', ahead: 2, behind: 1, hasRemote: true, branchless: false };

describe('SidebarGroup', () => {
  it('folds on a second press and opens again on a third', () => {
    render(<SidebarGroup title="Stashes" count={1}><p>stash body</p></SidebarGroup>);
    const toggle = screen.getByRole('button', { name: /Stashes/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByText('stash body')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText('stash body')).toBeInTheDocument();
  });

  it('starts folded when asked, and opens on demand', () => {
    render(<SidebarGroup title="Local" startOpen={false}><p>long list</p></SidebarGroup>);
    expect(screen.queryByText('long list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Local/ }));
    expect(screen.getByText('long list')).toBeInTheDocument();
  });
});

describe('MiddleText', () => {
  it('keeps the tail of a long text and the whole of it as the tooltip', () => {
    const { container } = render(<MiddleText text="packages/desktop/src/renderer/views/git/GitSidebar.tsx" path />);
    expect(container.querySelector('.mid-tail')?.textContent).toBe('/GitSidebar.tsx');
    expect(container.querySelector('.mid')).toHaveAttribute('title', 'packages/desktop/src/renderer/views/git/GitSidebar.tsx');
  });

  it('splits a long branch at a word boundary in the markup', () => {
    const { container } = render(<MiddleText text="feature/search-box-rewritten-for-unicode-normalisation-and-very-long-query-strings" />);
    expect(container.querySelector('.mid-tail')?.textContent).toBe('query-strings');
  });

  it('leaves a short text whole', () => {
    const { container } = render(<MiddleText text="main" />);
    expect(container.querySelector('.mid-tail')).toBeNull();
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});

describe('splitMiddle', () => {
  it('keeps whole trailing words of a long branch, not a mid-word cut', () => {
    const branch = 'feature/search-box-rewritten-for-unicode-normalisation-and-very-long-query-strings';
    expect(splitMiddle(branch)).toEqual({ head: branch.slice(0, -'query-strings'.length), tail: 'query-strings' });
  });

  it('cuts at every kind of word boundary, within 40% of the text', () => {
    for (const text of ['release_candidate_for_the_new_checkout_flow_final', 'a long name with several words in it, ending here', 'v2.14.0.rc.1.build.2024.11.09.hotfix.final.r2']) {
      const split = splitMiddle(text)!;
      expect(split.head + split.tail).toBe(text);
      expect(split.tail.length).toBeGreaterThanOrEqual(12);
      expect(split.tail.length).toBeLessThanOrEqual(Math.max(12, Math.floor(text.length * 0.4)));
      expect('-_. '.includes(split.head.at(-1)!)).toBe(true);
    }
  });

  it('keeps a path\'s last segment, with its slash', () => {
    const path = 'packages/desktop/src/renderer/views/git/GitSidebar.tsx';
    expect(splitMiddle(path, { path: true })?.tail).toBe('/GitSidebar.tsx');
    expect(splitMiddle('/home/me/.ordewell/worktrees/324bfb86/14-sidebar-shorten', { path: true })?.tail).toBe('/14-sidebar-shorten');
    // A short last segment takes the folder before it, to reach the least tail.
    expect(splitMiddle('src/components/navigation/shell/index.tsx', { path: true })?.tail).toBe('/shell/index.tsx');
  });

  it('keeps a path\'s last segment past the 40% share, up to 40 characters', () => {
    const name = 'TheVeryLongPrimaryNavigation.tsx';
    const path = `src/components/${name}`;
    expect(splitMiddle(path, { path: true })?.tail).toBe(`/${name}`);
    const longer = `src/${'segment'.repeat(10)}.tsx`;
    expect(splitMiddle(longer, { path: true })?.tail.length).toBeLessThanOrEqual(40);
  });

  it('falls back to a plain cut for one long word, and to the longest boundary tail that fits', () => {
    const word = 'a'.repeat(60);
    expect(splitMiddle(word)).toEqual({ head: 'a'.repeat(48), tail: 'a'.repeat(12) });
    expect(splitMiddle(word, { path: true })?.tail).toBe('a'.repeat(24));
    const long = `feature/${'b'.repeat(50)}-end`;
    expect(splitMiddle(long)?.tail).toBe('bbbbbbbb-end');
  });

  it('leaves a short text whole', () => {
    expect(splitMiddle('main')).toBeUndefined();
    expect(splitMiddle('feature/login-form')).toBeUndefined();
    expect(splitMiddle('feature/login-form-x', { tail: 16 })).toBeUndefined();
  });
});

describe('SyncBar', () => {
  const actions = () => ({ fetch: vi.fn(async () => undefined), pull: vi.fn(async () => undefined), push: vi.fn(async () => undefined) });

  it('draws each count inside its button, behind before ahead, and runs the action pressed', () => {
    const a = actions();
    render(<SyncBar state={TRACKING} actions={a} label="main" />);
    const pull = screen.getByRole('button', { name: 'Pull' });
    expect(pull.querySelector('.sync-n')).toHaveTextContent('1');
    expect(screen.getByRole('button', { name: 'Push' }).querySelector('.sync-n')).toHaveTextContent('2');
    expect(pull.compareDocumentPosition(screen.getByRole('button', { name: 'Push' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(pull);
    expect(a.pull).toHaveBeenCalledTimes(1);
  });

  it('names the target and the count, in plural or not, in each tooltip', () => {
    render(<SyncBar state={{ ...TRACKING, ahead: 1, behind: 3 }} actions={actions()} label="main" />);
    expect(screen.getByRole('button', { name: 'Pull' })).toHaveAttribute('title', 'Pull 3 commits from origin/main');
    expect(screen.getByRole('button', { name: 'Push' })).toHaveAttribute('title', 'Push 1 commit to origin/main');
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveAccessibleDescription('Fetch from the remote');
  });

  // The box keeps its room when empty, so 0 becoming 1 moves nothing; over two digits it says 99+.
  it('draws no count for nothing to move, and caps a long one', () => {
    render(<SyncBar state={{ ...TRACKING, ahead: 0, behind: 250 }} actions={actions()} label="main" />);
    const push = screen.getByRole('button', { name: 'Push' }).querySelector('.sync-n');
    expect(push).toBeInTheDocument();
    expect(push).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Pull' }).querySelector('.sync-n')).toHaveTextContent('99+');
  });

  it('keeps an up-to-date branch to the buttons: each reason is a tooltip and a description, not a line', () => {
    const { container } = render(<SyncBar state={{ ...TRACKING, ahead: 0, behind: 0 }} actions={actions()} label="main" />);
    const pull = screen.getByRole('button', { name: 'Pull' });
    expect(pull).toBeDisabled();
    expect(pull).toHaveAccessibleDescription('Nothing to pull: origin/main has no new commits');
    expect(screen.getByRole('button', { name: 'Push' })).toHaveAccessibleDescription('Nothing to push: origin/main has every commit');
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled();
    expect(container.querySelector('.sync-note')).toBeNull();
  });

  it('says once, on its own line, that there is no remote', () => {
    render(<SyncBar state={{ upstream: null, ahead: 0, behind: 0, hasRemote: false, branchless: false }} actions={actions()} label="main" />);
    expect(screen.getAllByText('No remote: add one to fetch, pull or push.')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveAccessibleDescription('Nothing to fetch: no remote is configured');
    expect(screen.getByRole('button', { name: 'Push' })).toHaveAccessibleDescription('Nothing to push: no remote is configured');
  });

  it('says a detached or unborn HEAD has no branch to move', () => {
    render(<SyncBar state={{ upstream: null, ahead: 0, behind: 0, hasRemote: true, branchless: true }} actions={actions()} label="main" />);
    expect(screen.getByText('No branch is checked out: Pull and Push need one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull' })).toHaveAccessibleDescription('Nothing to pull: no branch is checked out');
  });

  it('lets a branch without an upstream be pushed, but not pulled, and says Push publishes it', () => {
    const state = { ...TRACKING, upstream: null };
    expect(pushBlocked(state)).toBeUndefined();
    expect(pullBlocked(state)).toMatch(/no upstream/);
    render(<SyncBar state={state} actions={actions()} label="main" />);
    expect(screen.getByText('Not published: Push publishes it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Push' })).toBeEnabled();
  });

  it('holds every button, with no note yet, while the remotes are read', () => {
    const { container } = render(<SyncBar state={{ ...TRACKING, upstream: null, hasRemote: undefined }} actions={actions()} label="main" />);
    for (const name of ['Pull', 'Push', 'Fetch']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription('Reading the remotes…');
    }
    expect(container.querySelector('.sync-note')).toBeNull();
  });

  it('draws the checkout line, branch then upstream, only when given a branch', () => {
    const { container, rerender } = render(<SyncBar state={TRACKING} actions={actions()} label="main" />);
    expect(container.querySelector('.sync-head')).toBeNull();
    rerender(<SyncBar state={TRACKING} actions={actions()} label="main" branch="feature/login" />);
    const head = container.querySelector('.sync-head')!;
    expect(head.querySelector('.sync-branch')).toHaveTextContent('feature/login');
    expect(head.querySelector('.sync-upstream')).toHaveTextContent('origin/main');
    rerender(<SyncBar state={{ ...TRACKING, upstream: null }} actions={actions()} label="main" branch="feature/login" />);
    expect(container.querySelector('.sync-upstream')).toBeNull();
  });
});
