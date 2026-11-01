import { accessSync, constants, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { git, isAncestor, tryGit, type GitInvoker } from '../gitExec';

/** Nothing a repository's hooks do belongs in this path: what is taken here came from a container. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** Git's own checks on what it takes from a stranger: a tree that writes into `.git`, a malformed object. */
const FSCK = ['-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true'];

/** What git runs on this host as a landing commits and merges, and as the next worktree is cut. */
const LANDING_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'post-checkout', 'post-rewrite', 'reference-transaction'];

/** What came out of a container and may not go further; the attempt's work stays in its volume. */
export class PushRefused extends Error {
  constructor(why: string) {
    super(`The container's work was refused: ${why}.`);
    this.name = 'PushRefused';
  }
}

/** What one attempt may bring back. */
export interface GateTicket {
  /** The only ref it may hold. */
  ref: string;
  /** Where the attempt started: what it brings back stands on this. */
  base: string;
}

/**
 * The only way work leaves a container (ADR-0059 L6). A bundle is all a
 * container hands over, so nothing of a repository's hooks or config can come
 * with it, as it could from a writable bare repository the host later runs git
 * in. It takes exactly the ticket's ref, under git's own object checks, and
 * only history on the attempt's base, and moves no ref of the repository at
 * `repo`. Returns the snapshot commit it took, whose first parent is the
 * attempt's last commit (see {@link restoreSnapshot}).
 */
export async function takeThroughGate(invoker: GitInvoker, repo: string, bundle: string, { ref, base }: GateTicket): Promise<string> {
  const listed = await tryGit(invoker, repo, ['bundle', 'list-heads', bundle]);
  if (!listed.ok) throw new PushRefused(`it is not a bundle git can read (${listed.stderr.trim()})`);
  const heads = listed.stdout.split('\n').filter(Boolean).map((line) => line.slice(line.indexOf(' ') + 1));
  const others = heads.filter((head) => head !== ref);
  if (others.length > 0 || heads.length === 0) throw new PushRefused(`it holds ${others.join(', ') || 'no ref'} where only ${ref} may come back`);

  const quarantine = ref.replace('refs/ordewell/export/', 'refs/ordewell/gate/');
  const fetched = await tryGit(invoker, repo, [...NO_HOOKS, ...FSCK, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance', bundle, `+${ref}:${quarantine}`]);
  if (!fetched.ok) throw new PushRefused(`git would not take it (${fetched.stderr.trim()})`);
  try {
    const snapshot = (await git(invoker, repo, ['rev-parse', '--verify', `${quarantine}^{commit}`])).trim();
    if (await isAncestor(invoker, repo, base, `${snapshot}^1`) !== 'yes') throw new PushRefused(`its history does not stand on ${base}`);
    await checkObjects(invoker, repo, snapshot, base);
    return snapshot;
  } finally {
    await tryGit(invoker, repo, [...NO_HOOKS, 'update-ref', '-d', quarantine]);
  }
}

/**
 * Hold what the snapshot brings to git's object checks. `FSCK` cannot be relied
 * on for this: a fetch from a bundle reads it from some git on (2.47 does, 2.40
 * does not) and an older one takes a tree that writes into `.git` without a word.
 * Packing the snapshot's own objects and indexing them strictly checks the same
 * things on every git, and only what could land.
 */
async function checkObjects(invoker: GitInvoker, repo: string, snapshot: string, base: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'ordewell-gate-'));
  try {
    const prefix = join(scratch, 'taken');
    const packed = await tryGit(invoker, repo, ['pack-objects', '--revs', '-q', prefix], `${snapshot}\n^${base}\n`);
    if (!packed.ok) throw new PushRefused(`git could not read what it holds (${packed.stderr.trim()})`);
    const checked = await tryGit(invoker, repo, ['index-pack', '--strict', '-o', join(scratch, 'checked.idx'), `${prefix}-${packed.stdout.trim()}.pack`]);
    if (!checked.ok) throw new PushRefused(`git would not take it (${checked.stderr.trim()})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Put a snapshot in a host worktree as a local attempt would have left it: the
 * attempt's own commits on its branch and the rest uncommitted, so that Landing
 * commits it under the handoff's message as for any other attempt. What the
 * worktree held goes, since the snapshot is all of the attempt's work, but for
 * `linked`, which Ordewell put there and no attempt ever saw.
 */
export async function restoreSnapshot(invoker: GitInvoker, worktree: string, snapshot: string, linked: readonly string[]): Promise<void> {
  const run = (...args: string[]) => git(invoker, worktree, [...NO_HOOKS, ...args]);
  await run('reset', '-q', '--hard');
  await run('clean', '-fdq', ...linked.flatMap((name) => ['-e', name]));
  await run('merge', '-q', '--ff-only', `${snapshot}^1`);
  await run('restore', `--source=${snapshot}`, '--staged', '--worktree', '--', '.');
  await run('reset', '-q');
}

/**
 * The hooks a landing would run on this host, over what a container wrote. A
 * hook that tests or lints runs that code, and one in a tracked folder is itself
 * the container's to change, so none of this can come through a gate. Landing
 * with hooks off would silently drop a check the user set up, so a lease refuses
 * instead (ADR-0059 L6).
 */
export async function hooksLandingWouldRun(invoker: GitInvoker, worktree: string): Promise<string[]> {
  const dir = resolve(worktree, (await git(invoker, worktree, ['rev-parse', '--git-path', 'hooks'])).trim());
  return LANDING_HOOKS.filter((hook) => {
    try {
      accessSync(resolve(dir, hook), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
