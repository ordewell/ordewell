// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { installBridge } from '../../../test/explorerHarness';
import type { FrameApi } from '../../../frame/api';
import { repositoryOf, ScopeStore, viewRepos } from '../scopeStore';

/**
 * Reproduction (plan task 14): a desktop user opens a parent folder holding
 * plain folders and several git repositories. The Explorer should start at the
 * selected workspace folder (repo '.'), not jump into the first repository.
 */

const api = { workspace: '/work/parent' } as unknown as FrameApi;

function bridge(repos: string[]): void {
  installBridge({
    'git.repos': () => ({ repos: repos.map((repo) => ({ repo, branch: 'main', detached: false })) }),
    'sessions.list': () => [],
  });
}

describe('ScopeStore.load on a folder of repositories', () => {
  it('keeps the Explorer on the selected workspace folder rather than switching to repos[0]', async () => {
    bridge(['api', 'web']);
    const store = new ScopeStore(api);
    expect(store.getSnapshot().repo).toBe('.');
    await store.refresh();
    expect(store.getSnapshot().repos.map((r) => r.repo)).toEqual(['api', 'web']);
    expect(store.getSnapshot().repo).toBe('.');
  });

  it('control: a workspace that is itself one repository stays at "."', async () => {
    bridge(['.']);
    const store = new ScopeStore(api);
    await store.refresh();
    expect(store.getSnapshot().repo).toBe('.');
  });

  it('control: choosing an individual repository is kept across a refresh', async () => {
    bridge(['api', 'web']);
    const store = new ScopeStore(api);
    await store.refresh();
    store.setRepo('web');
    await store.refresh();
    expect(store.getSnapshot().repo).toBe('web');
  });
});

describe('the workspace folder beside its repositories', () => {
  it('falls back to the folder, not the first repository, when the picked repository is gone', async () => {
    bridge(['api', 'web']);
    const store = new ScopeStore(api);
    await store.refresh();
    store.setRepo('web');
    bridge(['api']);
    await store.refresh();
    expect(store.getSnapshot().repo).toBe('.');
  });

  it('defaults to the folder in a workspace that holds one repository below it, and in one that holds none', async () => {
    bridge(['api']);
    const one = new ScopeStore(api);
    await one.refresh();
    expect(one.getSnapshot().repo).toBe('.');
    bridge([]);
    const none = new ScopeStore(api);
    await none.refresh();
    expect(none.getSnapshot().repo).toBe('.');
  });

  it('lists the folder first beside the repositories, and alone where the workspace is its own repository', () => {
    const state = (repos: string[], repo = '.') => ({ repos: repos.map((r) => ({ repo: r, branch: 'main', detached: false })), repo });
    expect(viewRepos(state(['api', 'web']))).toEqual(['.', 'api', 'web']);
    expect(viewRepos(state(['api']))).toEqual(['.', 'api']);
    expect(viewRepos(state(['.']))).toEqual(['.']);
    expect(viewRepos(state([]))).toEqual(['.']);
  });

  it('gives a git surface a repository while the pick is the folder that has none', () => {
    const state = (repos: string[], repo: string) => ({ repos: repos.map((r) => ({ repo: r, branch: 'main', detached: false })), repo });
    expect(repositoryOf(state(['api', 'web'], '.'))).toBe('api');
    expect(repositoryOf(state(['api', 'web'], 'web'))).toBe('web');
    expect(repositoryOf(state(['.'], '.'))).toBe('.');
    expect(repositoryOf(state([], '.'))).toBe('.');
  });

  it('keeps two windows on different workspaces apart', async () => {
    bridge(['api', 'web']);
    const first = new ScopeStore(api);
    const second = new ScopeStore({ workspace: '/work/other' } as unknown as FrameApi);
    await Promise.all([first.refresh(), second.refresh()]);
    first.setRepo('api');
    expect(second.getSnapshot().repo).toBe('.');
  });
});
