/**
 * The repository a run plans against: Ordewell itself at the baseline commit,
 * with the goal's setup patches applied, as a fresh throwaway clone per run.
 *
 * Each goal's tree is cut once into a template repository holding a single
 * commit, and every run clones that. A single commit, not the real history,
 * so that G4's planted bug is not there for `git diff` or `git log` to give
 * away; every goal gets the same treatment, so no goal's history tells the
 * planner more than another's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { must } from './proc.mjs';

const IDENTITY = ['-c', 'user.name=planner-eval', '-c', 'user.email=planner-eval@localhost', '-c', 'commit.gpgsign=false'];

/** Apply `patches` to the tree at `dir`, each `find` required to occur exactly once. */
export function applyPatches(dir, patches = []) {
  for (const { file, find, replace } of patches) {
    const target = path.join(dir, ...file.split('/'));
    const text = fs.readFileSync(target, 'utf8');
    const count = text.split(find).length - 1;
    if (count !== 1) throw new Error(`setup patch for ${file}: the text to replace occurs ${count} times, not once`);
    fs.writeFileSync(target, text.replace(find, () => replace));
  }
}

/** The template for `goal` at `sha`, cut now unless an earlier run left it. */
export async function ensureTemplate({ repo, templatesDir, sha, goal }) {
  const dir = path.join(templatesDir, `${goal.id}-${sha.slice(0, 12)}`);
  if (fs.existsSync(path.join(dir, '.git', 'planner-eval-ready'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(templatesDir, `${goal.id}-${sha.slice(0, 12)}.tar`);
  await must('git', ['archive', '--format=tar', '-o', archive, sha], { cwd: repo });
  await must('tar', ['-xf', archive, '-C', dir]);
  fs.rmSync(archive, { force: true });
  applyPatches(dir, goal.setup?.patches);
  await must('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await must('git', ['add', '-A'], { cwd: dir });
  await must('git', [...IDENTITY, 'commit', '-q', '-m', 'Ordewell'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.git', 'planner-eval-ready'), `${sha}\n`);
  return dir;
}

/**
 * A copy of the tree at `from` into `to`: each file hard-linked where the two
 * share a file system and copied where they do not, each symlink recreated
 * verbatim so a workspace package's relative link (`@ordewell/core` →
 * `../../packages/core`) resolves inside the copy, not back in the build.
 */
export function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      const dir = fs.statSync(src, { throwIfNoEntry: false })?.isDirectory();
      fs.symlinkSync(target, dest, dir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    } else if (entry.isDirectory()) {
      linkTree(src, dest);
    } else {
      try {
        fs.linkSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

/**
 * A run's own clone of `template` at `dir`. With `modulesFrom`, the clone gets
 * the `node_modules` (gitignored there) of a build of the same commit as real
 * directories inside it, not links out of it: a planner's test command that
 * the sandbox seals sees only the workspace, and a link to the build resolves
 * to nothing there.
 */
export async function cloneTarget({ template, dir, modulesFrom }) {
  await must('git', ['clone', '-q', template, dir]);
  // The template's path would tell the planner it is in a bench.
  await must('git', ['remote', 'remove', 'origin'], { cwd: dir });
  if (modulesFrom) {
    const roots = ['.', ...fs.readdirSync(path.join(modulesFrom, 'packages')).map((p) => path.join('packages', p))];
    for (const rel of roots) {
      const from = path.join(modulesFrom, rel, 'node_modules');
      const to = path.join(dir, rel, 'node_modules');
      if (fs.existsSync(from) && fs.existsSync(path.dirname(to)) && !fs.existsSync(to)) linkTree(from, to);
    }
  }
  return dir;
}

/**
 * Where the runs' clones go: the system's temporary directory, unless it is
 * on another file system than the builds, in which case a directory beside
 * the user's cache that shares theirs, so `linkTree` links rather than copies
 * a build's node_modules into every clone.
 */
export function workParent(buildsDir, candidates = [os.tmpdir(), path.join(os.homedir(), '.cache')]) {
  const device = (p) => fs.statSync(p, { throwIfNoEntry: false })?.dev;
  const want = device(buildsDir);
  return candidates.find((c) => want !== undefined && device(c) === want) ?? candidates[0];
}
