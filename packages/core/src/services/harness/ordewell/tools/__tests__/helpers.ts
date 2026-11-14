import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { removeDir } from '../../../../../testEnv';
import type { ToolContext } from '../types';

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => removeDir(dir)));
});

/** A worktree and an output directory beside it (never inside), under a scratch directory of their own. */
export function scratch(): { root: string; worktree: string; outputDir: string; context: ToolContext } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ordewell-tools-')));
  made.push(root);
  const worktree = path.join(root, 'worktree');
  const outputDir = path.join(root, 'data', 'tool-output');
  mkdirSync(worktree, { recursive: true });
  return { root, worktree, outputDir, context: { worktree, outputDir, signal: new AbortController().signal, env: process.env } };
}
