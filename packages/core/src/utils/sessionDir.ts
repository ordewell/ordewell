import * as path from 'path';
import { getStateDir } from './fsHelpers';

/**
 * Where sessions keep their state, apart from the store that reads it: a
 * client that is no host (the desktop app's main process) finds a session's
 * lease here without loading the plan model the store brings with it.
 */

const SESSIONS_SUBDIR = 'sessions';

export function getSessionsDir(baseDir?: string): string {
  return path.join(getStateDir(baseDir), SESSIONS_SUBDIR);
}

/**
 * A path segment for an id that came from outside — a session id from a URL,
 * a task id a planner wrote. A plain id is used as is; anything that could
 * climb out of its directory, or is not portable as a file name, is hex-encoded.
 */
export function idSegment(id: string): string {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(id) ? id : `~${Buffer.from(id, 'utf-8').toString('hex')}`;
}
