export interface SessionRow {
  id: string;
  goal: string;
  status: string;
  taskCount: number;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GET /api/sessions's `SessionMeta[]`, newest first; undefined when the answer is not that list. */
export function parseSessions(data: unknown): SessionRow[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const rows: SessionRow[] = [];
  for (const meta of data) {
    if (!isRecord(meta) || typeof meta.id !== 'string') return undefined;
    rows.push({
      id: meta.id,
      goal: typeof meta.goal === 'string' ? meta.goal : '',
      status: typeof meta.status === 'string' ? meta.status : 'unknown',
      taskCount: typeof meta.taskCount === 'number' ? meta.taskCount : 0,
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : typeof meta.createdAt === 'string' ? meta.createdAt : '',
    });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
