import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MiddleText, SidebarGroup, pathTail } from '../sidebarKit';
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
    const { container } = render(<MiddleText text="packages/desktop/src/renderer/views/git/GitSidebar.tsx" tail={14} />);
    expect(container.querySelector('.mid-tail')?.textContent).toBe('GitSidebar.tsx');
    expect(container.querySelector('.mid')).toHaveAttribute('title', 'packages/desktop/src/renderer/views/git/GitSidebar.tsx');
  });

  it('leaves a short text whole', () => {
    const { container } = render(<MiddleText text="main" />);
    expect(container.querySelector('.mid-tail')).toBeNull();
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});

describe('pathTail', () => {
  it('keeps the last segment of a path whole, within bounds', () => {
    expect(pathTail('a/b')).toBe(12);
    expect(pathTail('src/components/TheVeryLongPrimaryNavigationControllerWithAnExtraordinaryName.tsx')).toBe(40);
    const path = 'packages/desktop/src/renderer/views/git/GitSidebar.tsx';
    expect(pathTail(path)).toBe('/GitSidebar.tsx'.length);
  });
});

describe('SyncBar', () => {
  const actions = () => ({ fetch: vi.fn(async () => undefined), pull: vi.fn(async () => undefined), push: vi.fn(async () => undefined) });

  it('shows the counts and runs the action pressed', () => {
    const a = actions();
    render(<SyncBar state={TRACKING} actions={a} label="main" />);
    expect(screen.getByText('↓ 1 ↑ 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
    expect(a.pull).toHaveBeenCalledTimes(1);
  });

  it('says in words why pull and push cannot act', () => {
    render(<SyncBar state={{ ...TRACKING, ahead: 0, behind: 0 }} actions={actions()} label="main" />);
    expect(screen.getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(screen.getByText(/Nothing to pull/)).toBeVisible();
    expect(screen.getByText(/Nothing to push/)).toBeVisible();
  });

  it('names the missing remote once', () => {
    render(<SyncBar state={{ upstream: null, ahead: 0, behind: 0, hasRemote: false, branchless: false }} actions={actions()} label="main" />);
    expect(screen.getAllByText('No remote is configured.')).toHaveLength(1);
  });

  it('lets a branch without an upstream be pushed, but not pulled', () => {
    const state = { ...TRACKING, upstream: null };
    expect(pushBlocked(state)).toBeUndefined();
    expect(pullBlocked(state)).toMatch(/no upstream/);
  });
});
