import type { SessionRunActivity } from '@ordewell/core';

export interface SessionRow {
  id: string;
  goal: string;
  status: string;
  taskCount: number;
  updatedAt: string;
  /** The daemon's word that the session's run is at work now; absent when it is not, or the daemon predates saying so. */
  run?: SessionRunActivity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** A listed run's activity; its counts only as a pair, since "Running 3/" says nothing. */
function parseRun(value: unknown): SessionRunActivity | undefined {
  if (!isRecord(value) || value.live !== true) return undefined;
  return isCount(value.done) && isCount(value.total) ? { live: true, done: value.done, total: value.total } : { live: true };
}

/** GET /api/sessions's `SessionListEntry[]`, newest first; undefined when the answer is not that list. */
export function parseSessions(data: unknown): SessionRow[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const rows: SessionRow[] = [];
  for (const meta of data) {
    if (!isRecord(meta) || typeof meta.id !== 'string') return undefined;
    const run = parseRun(meta.run);
    rows.push({
      id: meta.id,
      goal: typeof meta.goal === 'string' ? meta.goal : '',
      status: typeof meta.status === 'string' ? meta.status : 'unknown',
      taskCount: typeof meta.taskCount === 'number' ? meta.taskCount : 0,
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : typeof meta.createdAt === 'string' ? meta.createdAt : '',
      ...(run ? { run } : {}),
    });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
