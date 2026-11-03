import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import { git, tryGit, type GitInvoker } from './gitExec';
import { stateRootOf } from './stateRoot';
import type { HandoffPatch } from '../models/Handoff';

export interface TaskDiffRead {
  /**
   * Only the changed paths, joined by NUL: what a verdict reads (ADR-0055 D6). It
   * holds every path the task's work changes, Ordewell state and `.git`-named
   * paths included, as a landing takes them: `allowedPath` decides what a person
   * is shown, and a path hidden from a verdict would land past a protected path.
   * A commit takes the whole worktree, so that reaches past a workspace that is a
   * folder of its repository: see {@link changeNames}. `'both'` asks for both of a
   * path's names, for a read that goes by a protected path alone (D7).
   */
  names?: boolean | 'both';
  repo?: string;
  path?: string;
}

export type TaskDiffResult = { available: true; text: string } | { available: false; reason: string };

export const TASK_DIFF_UNAVAILABLE = 'Task diff is not available for this run: no task-specific changes were recorded (shared runs cannot attribute workspace changes to one task).';

interface DiffFile {
  repo: string;
  path: string;
  added: string;
  removed: string;
  patch(): Promise<string>;
}

export function allowedPath(file: string): boolean {
  return file.length > 0 && !path.isAbsolute(file) && !/^[A-Za-z]:/.test(file)
    && !file.split(/[\\/]/).some((part) => part === '..' || part === '.git' || part === '.ordewell');
}

/**
 * What a change is called, given its path from the repository's root and the
 * folder of the repository the workspace is: its place in the workspace, or its
 * path from the root where it lies beside that folder. A planner reads the
 * workspace and D7 says a rule is read from the root, so a rule may name a change
 * in the folder either way, and `both` gives each name.
 */
export function changeNames(file: string, prefix: string, both: boolean): string[] {
  if (!file.startsWith(prefix)) return [file];
  const place = file.slice(prefix.length);
  return both && prefix ? [place, file] : [place];
}

function stats(raw: string): Array<{ path: string; added: string; removed: string }> {
  return raw.split('\0').flatMap((row) => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
    return match ? [{ path: match[3], added: match[1], removed: match[2] }] : [];
  });
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** A C-quoted path as git writes one with special characters (`"a\tb"`, `"caf\303\251"`), read back. */
export function unquoted(quoted: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };
  for (let i = 1; i < quoted.length - 1; i++) {
    const ch = quoted[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
    } else if (/[0-7]/.test(quoted[i + 1] ?? '')) {
      bytes.push(parseInt(quoted.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[quoted[i + 1]] ?? quoted.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The path one `diff --git` section of a patch changes: where a rename goes, else the path it names twice. */
function sectionPath(section: string): string {
  const renamed = /^rename to (.*)$/m.exec(section)?.[1];
  if (renamed !== undefined) return renamed.startsWith('"') ? unquoted(renamed) : renamed;
  const header = section.slice('diff --git '.length, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n'));
  if (header.startsWith('"')) {
    const second = header.slice(header.indexOf('" ') + 2);
    return (second.startsWith('"') ? unquoted(second) : second).replace(/^b\//, '');
  }
  return header.slice(2, 2 + (header.length - 5) / 2);
}

/** Lines a section adds and removes, or `-` for a binary one, as `--numstat` writes them. */
function sectionStats(section: string): { added: string; removed: string } {
  if (/^GIT binary patch$/m.test(section) || /^Binary files /m.test(section)) return { added: '-', removed: '-' };
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of section.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) added += 1;
    else if (inHunk && line.startsWith('-')) removed += 1;
  }
  return { added: String(added), removed: String(removed) };
}

/** The sum of two sections' counts for one path, or `-` when either change is binary. */
function summed(a: string, b: string): string {
  return a === '-' || b === '-' ? '-' : String(Number(a) + Number(b));
}

/**
 * The files a patch changes, each with its own part and line counts (`-` for
 * a binary change). A file whose type changes is two sections of a patch, a
 * removal and an addition, and one file: its parts are joined.
 */
export function patchFiles(patch: Buffer): Array<{ path: string; section: string; added: string; removed: string }> {
  // A section starts at the beginning of a line: only a newline ends one for git, where `^` also takes a carriage return.
  const sections = patch.toString('utf8').split(/(?<![^\n])(?=diff --git )/).filter((section) => section.startsWith('diff --git '));
  const files = new Map<string, { path: string; section: string; added: string; removed: string }>();
  for (const section of sections) {
    const path = sectionPath(section);
    const counts = sectionStats(section);
    const earlier = files.get(path);
    files.set(path, earlier
      ? { path, section: earlier.section + section, added: summed(earlier.added, counts.added), removed: summed(earlier.removed, counts.removed) }
      : { path, section, ...counts });
  }
  return [...files.values()];
}

/**
 * A read-only task's saved patch as `task_diff` reads it (ADR-0050): its
 * worktree is gone and Ordewell ran no git in it, so the patch it saved is
 * what it changed. The file list with stats, or one file's part, in the
 * shape a change task's diff has.
 */
export function readSavedPatch(patch: Buffer | undefined, saved: Pick<HandoffPatch, 'attempt' | 'base' | 'bytes' | 'sha256'>, options: TaskDiffRead): TaskDiffResult {
  if (!patch) return { available: false, reason: `Task diff is not available: the patch attempt ${saved.attempt} saved is no longer in this session's task logs.` };
  // A change task's commands can write the session's directory, so the file is the task's work only while it is the bytes its artifact records, as apply_patch checks.
  if (patch.length !== saved.bytes || createHash('sha256').update(patch).digest('hex') !== saved.sha256) {
    return { available: false, reason: `Task diff is not available: the patch file has changed since attempt ${saved.attempt} saved it: its size or hash is not the one its artifact records. It is not that task's work, and apply_patch refuses it too.` };
  }
  if (options.repo !== undefined && options.repo !== '.') return { available: false, reason: `No repository matches "${options.repo}" in this task's saved patch: it has one, ".".` };
  const files = patchFiles(patch);
  if (options.path !== undefined) {
    const selected = files.filter((f) => f.path === options.path);
    if (selected.length === 0) return { available: false, reason: `No changed file matches "${options.path}" in this task's saved patch. Read the file list first.` };
    return { available: true, text: selected.map((f) => `[repo .] ${f.path}\n${f.section}`).join('\n') };
  }
  const head = `The patch attempt ${saved.attempt} saved, against commit ${saved.base.slice(0, 12)}; the task's worktree is gone.\n`;
  return { available: true, text: head + files.map((f) => `[repo .] ${f.path}: ${f.added === '-' ? 'binary change' : `+${f.added} -${f.removed}`}\n`).join('') };
}

export async function readTaskDiff(invoker: GitInvoker, run: IsolationRun, taskId: string, options: TaskDiffRead): Promise<TaskDiffResult> {
  const record = run.tasks[taskId];
  if (!record) return { available: false, reason: TASK_DIFF_UNAVAILABLE };
  // A read-only task's sealed runs may write its worktree, `.git` file
  // included: git run there could load a repository the task planted. Ordewell
  // runs no git in such a worktree (ADR-0046); the task's report is its result.
  if (record.readOnly) return { available: false, reason: 'Task diff is not available for a read-only task: it lands nothing, and Ordewell runs no git in its worktree. Its report is its result.' };
  if (options.path !== undefined && !allowedPath(options.path)) {
    return { available: false, reason: 'Refused task_diff path: use a literal repo-relative file path from the file list, without traversal or Ordewell state paths.' };
  }
  if (options.repo !== undefined && !run.repos.some((r) => r.path === options.repo)) {
    return { available: false, reason: `No repository matches "${options.repo}" in this run.` };
  }
  const reader: GitInvoker = {
    ...invoker,
    exec: (file, args, opts) => invoker.exec(file, args, { ...opts, env: { ...opts.env, GIT_OPTIONAL_LOCKS: '0' } }),
  };
  try {
    const files: DiffFile[] = [];
    // A child's worktrees and its code root both sit under the state root (ADR-0055 D11).
    const workspaceRoot = fs.realpathSync(stateRootOf(run));
    for (const repo of run.repos) {
      if (options.repo !== undefined && repo.path !== options.repo) continue;
      const entry = record.repos[repo.path];
      if (!entry?.baseRef) return { available: false, reason: `Task diff is not available for repository ${repo.path}: this older run did not record the task's starting commit.` };
      if (!/^[a-f0-9]{40,64}$/.test(entry.baseRef)) throw new Error('Invalid recorded starting commit.');
      const live = record.status !== 'merged' && fs.existsSync(entry.worktree);
      const cwd = live ? entry.worktree : repo.root;
      if (!inside(workspaceRoot, fs.realpathSync(cwd))) throw new Error('The recorded task repository moved outside the workspace.');
      if (live) {
        const toplevel = (await git(reader, cwd, ['rev-parse', '--show-toplevel'])).trim();
        // Native: git names the worktree in long form with forward slashes, and on
        // Windows the record may hold an 8.3 short name or a lower-case drive letter,
        // which only the native call resolves to the same path.
        if (fs.realpathSync.native(toplevel) !== fs.realpathSync.native(entry.worktree)) throw new Error('The recorded task worktree is no longer a repository.');
      }
      const prefix = (await git(reader, repo.root, ['rev-parse', '--show-prefix'])).trim();
      const common = ['--no-pager', '-c', 'core.fsmonitor=false'];
      // A worktree comparison may run clean filters even with textconv disabled.
      const filters = await tryGit(reader, cwd, [...common, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
      if (!filters.ok && filters.code !== 1) throw new Error('Could not inspect git filter configuration.');
      for (const key of filters.stdout.trim().split('\n').filter(Boolean)) common.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
      let target: string[] = [];
      if (!live) {
        const tip = entry.taskTip ?? (await git(reader, repo.root, [...common, 'rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`])).trim();
        if (!/^[a-f0-9]{40,64}$/.test(tip)) throw new Error('Invalid task commit.');
        target = [tip];
      }
      const ordewells = (file: string) => entry.linked.some((linked) => file === linked || file.startsWith(`${linked}/`))
        || run.shared.some((shared) => repo.path === '.' && (file === shared || file.startsWith(`${shared}/`)));
      if (options.names) {
        const tracked = stats(await git(reader, cwd, [...common, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--relative=', entry.baseRef, ...target, '--numstat', '-z']));
        const fresh = live ? (await git(reader, cwd, [...common, 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean) : [];
        const work = fresh.filter((f) => !(f.startsWith(prefix) && ordewells(f.slice(prefix.length))));
        for (const file of [...tracked.map((f) => f.path), ...work]) {
          for (const name of changeNames(file, prefix, options.names === 'both')) files.push({ repo: repo.path, path: name, added: '-', removed: '-', patch: async () => '' });
        }
        continue;
      }
      const scope = prefix ? [`:(top,literal)${prefix.replace(/\/$/, '')}`] : [];
      const diffArgs = [...common, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', `--relative=${prefix}`, entry.baseRef, ...target];
      const listed = stats(await git(reader, cwd, [...diffArgs, '--numstat', '-z', '--', ...scope]));
      const allowed = (file: string) => allowedPath(file) && !ordewells(file);
      // A tracked path is in the diff only because the task put it there: Ordewell's links are never committed.
      for (const file of listed.filter((f) => allowed(f.path))) {
        files.push({ ...file, repo: repo.path, patch: () => git(reader, cwd, [...diffArgs, '--', `:(top,literal)${prefix}${file.path}`]) });
      }
      if (live) {
        const workspace = path.join(entry.worktree, prefix);
        const others = await git(reader, workspace, [...common, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
        for (const file of others.split('\0').filter((f) => f && allowed(f))) {
          const full = path.join(workspace, file);
          if (!inside(fs.realpathSync(workspace), fs.realpathSync(path.dirname(full)))) continue;
          // Git's own name for the empty side, on every platform: it cannot open Windows' `os.devNull`.
          const untracked = async (numstat: boolean): Promise<string> => {
            const result = await tryGit(reader, workspace, [...common, 'diff', '--no-index', '--no-renames', '--no-ext-diff', '--no-textconv', ...(numstat ? ['--numstat', '-z'] : []), '--', '/dev/null', file]);
            if (!result.ok && result.code !== 1) throw new Error(result.stderr.trim() || 'Could not read an untracked file diff.');
            return result.stdout;
          };
          const counts = /^(\d+|-)\t(\d+|-)\t/.exec(await untracked(true));
          if (counts) files.push({ repo: repo.path, path: file, added: counts[1], removed: counts[2], patch: () => untracked(false) });
        }
      }
    }
    if (options.path !== undefined) {
      const selected = files.filter((f) => f.path === options.path);
      if (selected.length === 0) return { available: false, reason: `No changed file matches "${options.path}"${options.repo ? ` in repository ${options.repo}` : ''}. Read the file list first.` };
      const patches: string[] = [];
      for (const file of selected) patches.push(`[repo ${file.repo}] ${file.path}\n${await file.patch()}`);
      return { available: true, text: patches.join('\n') };
    }
    // NUL-joined for a reader that is no person, since a path can hold anything else.
    if (options.names) return { available: true, text: files.map((f) => (f.repo === '.' ? f.path : `${f.repo}/${f.path}`)).join('\0') };
    return { available: true, text: files.length ? files.map((f) => `[repo ${f.repo}] ${f.path}: ${f.added === '-' ? 'binary change' : `+${f.added} -${f.removed}`}\n`).join('') : 'No files changed since this task started.\n' };
  } catch (err: unknown) {
    return { available: false, reason: `Task diff is not available: ${err instanceof Error ? err.message : String(err)}` };
  }
}
