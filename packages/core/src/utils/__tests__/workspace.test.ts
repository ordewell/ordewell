import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertWorkspaceExists,
  WorkspaceNotFoundError,
  assertWorkspaceIsProject,
  WorkspaceNotAProjectError,
} from '../workspace';

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

describe('assertWorkspaceIsProject', () => {
  it('does not throw for a directory carrying an .ordewell state directory (existing workspace)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    mkdirSync(join(dir, '.ordewell'));
    try {
      expect(() => assertWorkspaceIsProject(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw for a directory carrying a version-control directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    mkdirSync(join(dir, '.git'));
    try {
      expect(() => assertWorkspaceIsProject(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw for a freshly cloned repo with no .ordewell state, only a manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    writeFileSync(join(dir, 'package.json'), '{}');
    try {
      expect(() => assertWorkspaceIsProject(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws WorkspaceNotAProjectError for a directory with no project marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    try {
      expect(() => assertWorkspaceIsProject(dir)).toThrow(WorkspaceNotAProjectError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the filesystem root', () => {
    expect(() => assertWorkspaceIsProject('/')).toThrow(WorkspaceNotAProjectError);
  });

  it('rejects an ordinary system directory', () => {
    expect(() => assertWorkspaceIsProject('/etc')).toThrow(WorkspaceNotAProjectError);
  });

  it('judges a path that traverses into an acceptable directory by where it resolves, not by the string as written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    mkdirSync(join(dir, '.git'));
    const link = join(tmpdir(), `ordewell-workspace-link-${process.pid}`);
    symlinkSync(dir, link);
    try {
      expect(() => assertWorkspaceIsProject(link)).not.toThrow();
    } finally {
      rmSync(link, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for a workspace that cannot be resolved', () => {
    const dir = join(tmpdir(), 'ordewell-workspace-does-not-exist');
    rmSync(dir, { recursive: true, force: true });
    expect(() => assertWorkspaceIsProject(dir)).toThrow(WorkspaceNotAProjectError);
  });

  it('names the workspace in the error message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-workspace-'));
    try {
      expect(() => assertWorkspaceIsProject(dir)).toThrow(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses injected deps instead of touching the real filesystem', () => {
    const seen: string[] = [];
    expect(() =>
      assertWorkspaceIsProject('/whatever', {
        realpath: (candidate) => candidate,
        exists: (candidate) => {
          seen.push(candidate);
          return candidate.endsWith('.git');
        },
      }),
    ).not.toThrow();
    expect(seen).toContain('/whatever/.git');
  });
});
