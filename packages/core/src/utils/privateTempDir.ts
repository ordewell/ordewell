import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** A directory a runner process is handed its files in: owner-only, outside any repository. */
export interface PrivateTempDir {
  path: string;
  /** `contents` as `fileName` in the directory, readable by its owner alone; the file's path. */
  write(fileName: string, contents: string): string;
  /** An empty directory `name` in the directory, its owner's alone; its path. */
  subdir(name: string): string;
  /** Remove the directory and all it holds. Idempotent, and never throws. */
  remove(): void;
}

/**
 * A new private directory in the temp directory, `ordewell-<kind>-<pid>-XXXXXX`.
 * What it holds can carry a token (ADR-0022 A5, ADR-0060 R4) or a whole system
 * prompt, so the leftovers of an Ordewell that died before removing its own are
 * swept first: only directories named as this kind names them, made by this
 * user, whose maker is no longer running. Its maker's process id is in the
 * name so a sweep can tell those from one still in use.
 */
export function privateTempDir(kind: string): PrivateTempDir {
  const parent = tmpdir();
  sweepLeftovers(parent, kind);
  const path = mkdtempSync(join(parent, `ordewell-${kind}-${process.pid}-`));
  return {
    path,
    write(fileName, contents) {
      const file = join(path, fileName);
      writeFileSync(file, contents, { mode: 0o600 });
      return file;
    },
    subdir(name) {
      const sub = join(path, name);
      mkdirSync(sub, { mode: 0o700 });
      return sub;
    },
    remove: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Windows will not remove a directory a live process has as its cwd,
        // or a file it holds open, and a dispose frees what the process owns
        // before it kills it: the removal is retried while the process exits,
        // rather than throwing out of the dispose before the kill. The sweep
        // is the last resort.
        void rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
      }
    },
  };
}

function sweepLeftovers(parent: string, kind: string): void {
  // `mkdtemp` ends the name with six characters of this set.
  const ours = new RegExp(`^ordewell-${kind}-(\\d+)-[A-Za-z0-9]{6}$`);
  let names: string[];
  try { names = readdirSync(parent); } catch { return; }
  const uid = process.getuid?.();
  for (const name of names) {
    const pid = ours.exec(name)?.[1];
    if (pid === undefined || running(Number(pid))) continue;
    const path = join(parent, name);
    try {
      // A link is never followed: the name alone does not make the target ours.
      const entry = lstatSync(path);
      if (!entry.isDirectory() || (uid !== undefined && entry.uid !== uid)) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove: a sweep never fails a start.
    }
  }
}

/** Whether `pid` may be a running process; anything but a plain "no such process" counts as running. */
function running(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
