import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Its maker's process id is in the name, so a later start can tell a
 * directory whose Ordewell died before removing it from one still in use;
 * `mkdtemp` ends the name with six characters of this set.
 */
const OURS = /^ordewell-acp-(\d+)-[A-Za-z0-9]{6}$/;

/** A directory an ACP process is handed its files in: owner-only, outside any repository. */
export interface AcpPrivateDir {
  path: string;
  /** `contents` as `fileName` in the directory, readable by its owner alone; the file's path. */
  write(fileName: string, contents: string): string;
  /** Remove the directory and all it holds. Idempotent. */
  remove(): void;
}

/**
 * A new private directory in the temp directory. What it holds can carry an
 * attempt's token (ADR-0060, R4), so the leftovers of an Ordewell that died
 * before removing its own are swept first: only directories named as this
 * module names them, made by this user, whose maker is no longer running.
 */
export function acpPrivateDir(): AcpPrivateDir {
  const parent = tmpdir();
  sweepLeftovers(parent);
  const path = mkdtempSync(join(parent, `ordewell-acp-${process.pid}-`));
  return {
    path,
    write(fileName, contents) {
      const file = join(path, fileName);
      writeFileSync(file, contents, { mode: 0o600 });
      return file;
    },
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

function sweepLeftovers(parent: string): void {
  let names: string[];
  try { names = readdirSync(parent); } catch { return; }
  const uid = process.getuid?.();
  for (const name of names) {
    const pid = OURS.exec(name)?.[1];
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
