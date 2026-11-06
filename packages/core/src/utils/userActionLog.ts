import * as fs from 'fs';
import * as path from 'path';
import { withFileLock } from './fileLock';
import { ensurePrivateDir } from './privateFile';
import { sessionDataDir } from './sessionStore';

/**
 * The one file a host that does not hold a session may write in its directory
 * (ADR-0062 G6, ADR-0049 L5): the lines of user git actions on the session's
 * landing branch, waiting for the holder to fold them into its timeline.
 */

const USER_ACTIONS_FILE = 'user-actions.jsonl';

export interface UserActionLine {
  text: string;
  at: string;
}

function logFile(sessionId: string, workspace: string): string {
  return path.join(sessionDataDir(sessionId, workspace), USER_ACTIONS_FILE);
}

export function appendUserAction(sessionId: string, workspace: string, line: UserActionLine): void {
  const file = logFile(sessionId, workspace);
  ensurePrivateDir(path.dirname(file));
  withFileLock(file, () => fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 }), 'record a user git action');
}

function isLine(value: unknown): value is UserActionLine {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.text === 'string' && typeof v.at === 'string';
}

/** The lines waiting, oldest first, removed as they are read so no two holders fold one twice. */
export function takeUserActions(sessionId: string, workspace: string): UserActionLine[] {
  const file = logFile(sessionId, workspace);
  if (!fs.existsSync(file)) return [];
  const raw = withFileLock(file, () => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
    fs.rmSync(file, { force: true });
    return text;
  }, 'read user git actions');
  return raw.split('\n').flatMap((entry) => {
    if (!entry.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(entry);
      return isLine(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
