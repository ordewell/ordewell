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
 * A run's own clone of `template` at `dir`. With `modulesFrom`, the clone's
 * `node_modules` (gitignored there) are links to a build of the same commit,
 * so a planner that runs a test finds the tools installed.
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
      if (fs.existsSync(from) && fs.existsSync(path.dirname(to)) && !fs.existsSync(to)) {
        fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }
  }
  return dir;
}
