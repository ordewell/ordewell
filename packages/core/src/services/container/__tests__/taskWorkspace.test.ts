import { describe, expect, it } from 'vitest';
import { mirrorDir, repoDir } from '../taskWorkspace';

describe('where a repository is in a container', () => {
  it('keeps a lone repository at the workspace', () => {
    expect(repoDir({ path: '.' })).toBe('/task/work');
  });

  it('keeps a group at its paths', () => {
    expect(repoDir({ path: 'services/api' })).toBe('/task/work/services/api');
  });

  it('gives every repo of a group a mirror of its own, however alike their paths: one shared would swap their pins', () => {
    const paths = ['a/b', 'a_b', 'a-b', 'a.b'];

    expect(new Set(paths.map((path) => mirrorDir({ path }))).size).toBe(paths.length);
  });

  it('writes a mirror path a shell and git take as it is', () => {
    expect(mirrorDir({ path: "it's a/repo $HOME" })).toMatch(/^\/mirror\/[0-9a-f]+\.git$/);
  });
});
