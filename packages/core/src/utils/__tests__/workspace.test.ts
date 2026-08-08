import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertWorkspaceExists, WorkspaceNotFoundError } from '../workspace';

describe('assertWorkspaceExists', () => {
  it('does not throw for a directory that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    try {
      expect(() => assertWorkspaceExists(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws WorkspaceNotFoundError for a path that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    rmSync(dir, { recursive: true, force: true });
    expect(() => assertWorkspaceExists(dir)).toThrow(WorkspaceNotFoundError);
  });

  it('names the missing path in the error message', () => {
    const dir = join(tmpdir(), 'ordewell-workspace-does-not-exist');
    rmSync(dir, { recursive: true, force: true });
    expect(() => assertWorkspaceExists(dir)).toThrow(dir);
  });

  it('throws for a path that exists but is a file, not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    const file = join(dir, 'not-a-dir.txt');
    writeFileSync(file, 'hi');
    try {
      expect(() => assertWorkspaceExists(file)).toThrow(WorkspaceNotFoundError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the injected isDirectory check instead of touching the real filesystem', () => {
    let asked: string | undefined;
    expect(() =>
      assertWorkspaceExists('/whatever', { isDirectory: (candidate) => { asked = candidate; return true; } }),
    ).not.toThrow();
    expect(asked).toBe('/whatever');
  });
});
