/**
 * One build of Ordewell per commit, each in its own git worktree under the
 * gitignored `.builds/`, installed and built core first, then web, then cli (each compiles
 * against the one before's `dist/`). A build that finished leaves a marker and is reused
 * by every later run of the same commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { must } from './proc.mjs';

const MARKER = '.planner-eval-built';

export async function resolveRef(repo, ref) {
  return (await must('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repo })).trim();
}

/** The checkout's root, which `ref`s are resolved in and worktrees added to. */
export async function repoRoot(from) {
  return (await must('git', ['rev-parse', '--show-toplevel'], { cwd: from })).trim();
}

/** The CLI entry point a build provides. */
export const cliMain = (dir) => path.join(dir, 'packages', 'cli', 'dist', 'main.js');

/** A built Ordewell at `sha`, built now unless an earlier run finished it. `say` reports progress. */
export async function ensureBuild({ repo, buildsDir, sha, say = () => {} }) {
  const dir = path.join(buildsDir, sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, MARKER)) && fs.existsSync(cliMain(dir))) return { dir, sha, main: cliMain(dir), reused: true };
  fs.mkdirSync(buildsDir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    // A directory left by an interrupted add is not a worktree git knows; start it again.
    fs.rmSync(dir, { recursive: true, force: true });
    say(`adding a worktree for ${sha.slice(0, 12)}`);
    // --force re-adds a path git still lists but whose directory is gone, without pruning the checkout's other worktrees.
    await must('git', ['worktree', 'add', '--force', '--detach', dir, sha], { cwd: repo });
  }
  // No install scripts: the build needs none, and Electron's would download a binary no run uses.
  const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', NODE_OPTIONS: '' };
  say(`installing ${sha.slice(0, 12)}`);
  await must('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, env });
  for (const pkg of ['core', 'web', 'cli']) {
    say(`building ${pkg} at ${sha.slice(0, 12)}`);
    await must('npm', ['run', 'build', '-w', `packages/${pkg}`], { cwd: dir, env });
  }
  fs.writeFileSync(path.join(dir, MARKER), `${sha}\n`);
  return { dir, sha, main: cliMain(dir), reused: false };
}
