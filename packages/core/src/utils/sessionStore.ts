import * as fs from 'fs';
import * as path from 'path';
import type { LegacyPlanState, PlanState } from '../models/Task';
import { migratePlanState } from '../models/Task';
import { migratePlanStateIsolation } from '../services/isolationRecord';
import type { SessionMeta, SessionData } from '../models/Session';
import { defaultLogger, type ILogger } from '../interfaces/ILogger';
import { getStateDir, ensureDir, ensureStateDirIgnored } from './fsHelpers';
import { mintSessionId } from './sessionId';

const SESSIONS_SUBDIR = 'sessions';

function getSessionsDir(baseDir?: string): string {
  return path.join(getStateDir(baseDir), SESSIONS_SUBDIR);
}

const REJECTION_MESSAGE = 'This session was created with an older version of Ordewell. Please re-plan.';

function hasScalarRunner(parsed: Record<string, unknown>): boolean {
  const meta = parsed.meta as Record<string, unknown> | undefined;
  const plan = parsed.plan as Record<string, unknown> | undefined;
  return (typeof meta?.runner === 'string') || (typeof plan?.runner === 'string');
}

function sanitizeName(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function filenameStem(session: SessionMeta): string {
  const date = new Date(session.createdAt).toISOString().replace(/:/g, '-').replace(/\..+/, '');
  return `${date}_${sanitizeName(session.goal) || 'session'}`;
}

/**
 * The id's random part names the file. Its first eight characters used to,
 * which stopped distinguishing anything once ids became `session-<hex>`: two
 * sessions with one goal saved in the same second — a conversation forked
 * twice — wrote the same file.
 */
function sessionFilename(session: SessionMeta): string {
  return `${filenameStem(session)}_${session.id.replace(/^session-/, '').slice(0, 8)}.json`;
}

/** The name {@link sessionFilename} gave before, still on disk for sessions saved then. */
function legacySessionFilename(session: SessionMeta): string {
  return `${filenameStem(session)}_${session.id.slice(0, 8)}.json`;
}

/**
 * A session saved under the old name moves to the new one on its next save,
 * rather than living on as a second file with the same id. Only a file that
 * really holds this id is removed — the old name was shared, by the bug above.
 */
function dropLegacyFile(sessionsDir: string, meta: SessionMeta): void {
  const legacy = path.join(sessionsDir, legacySessionFilename(meta));
  if (legacy === path.join(sessionsDir, sessionFilename(meta)) || !fs.existsSync(legacy)) return;
  try {
    const held = (JSON.parse(fs.readFileSync(legacy, 'utf-8')) as SessionData).meta?.id;
    if (held === meta.id) fs.unlinkSync(legacy);
  } catch {
    // Unreadable: not provably this session's, so it stays.
  }
}

export function saveSession(plan: LegacyPlanState, goal: string, baseDir?: string, id?: string): SessionMeta {
  const sessionsDir = getSessionsDir(baseDir);
  ensureDir(sessionsDir);
  ensureStateDirIgnored(baseDir);

  const now = new Date().toISOString();

  const meta: SessionMeta = {
    id: id || mintSessionId(),
    goal: goal || '(untitled)',
    runners: plan.runners,
    taskCount: plan.tasks.flatMap((t) => [t, ...(((t as unknown) as { subtasks?: unknown[] }).subtasks || [])]).length,
    status: plan.status,
    createdAt: plan.generatedAt || now,
    updatedAt: now,
  };

  const session: SessionData = {
    meta,
    plan: JSON.parse(JSON.stringify(plan)),
  };

  const filename = sessionFilename(meta);
  const filePath = path.join(sessionsDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  dropLegacyFile(sessionsDir, meta);

  return meta;
}

export function listSessions(baseDir?: string, logger: ILogger = defaultLogger): SessionMeta[] {
  const sessionsDir = getSessionsDir(baseDir);
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));

  return files
    .map((f) => {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
        const parsed = JSON.parse(raw);
        if (hasScalarRunner(parsed)) {
          logger.warn('sessionStore', `session file ${f}: ${REJECTION_MESSAGE}`);
          return null;
        }
        const session = parsed as SessionData;
        return session.meta;
      } catch (err: unknown) {
        logger.warn('sessionStore', `failed to read session file ${f}; skipping`, err);
        return null;
      }
    })
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function findSessionFile(sessionsDir: string, sessionId: string, logger: ILogger): string | null {
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, f), 'utf-8');
      const session = JSON.parse(raw) as SessionData;
      if (session.meta.id === sessionId) return f;
    } catch (err: unknown) {
      logger.warn('sessionStore', `failed to read session file ${f}; skipping`, err);
    }
  }
  return null;
}

export function loadSession(sessionId: string, baseDir?: string, logger: ILogger = defaultLogger): { meta: SessionMeta; plan: LegacyPlanState } | null {
  const sessionsDir = getSessionsDir(baseDir);
  if (!fs.existsSync(sessionsDir)) return null;
  try {
    const file = findSessionFile(sessionsDir, sessionId, logger);
    if (file) {
      const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
      const parsed = JSON.parse(raw);
      if (hasScalarRunner(parsed)) {
        logger.warn('sessionStore', `session file ${file}: ${REJECTION_MESSAGE}`);
        return null;
      }
      const session = parsed as SessionData;
      const plan = session.plan as LegacyPlanState;
      // Nothing is running when a session comes off disk — an in_progress
      // status is an orphan from an interrupted run; give it a fresh chance.
      for (const t of plan.tasks.flatMap((task) => [task, ...(task.subtasks ?? [])])) {
        if (t.status === 'in_progress') t.status = 'pending';
      }
      migratePlanStateIsolation(plan);
      return { meta: session.meta, plan };
    }
  } catch (err: unknown) {
    logger.warn('sessionStore', `failed to list sessions directory while searching for ${sessionId}`, err);
  }
  return null;
}

export function loadSessionPlanState(sessionId: string, baseDir?: string, logger: ILogger = defaultLogger): { meta: SessionMeta; plan: PlanState } | null {
  const result = loadSession(sessionId, baseDir, logger);
  if (!result) return null;
  return { meta: result.meta, plan: migratePlanState(result.plan) };
}

export function getLatestSession(baseDir?: string, logger: ILogger = defaultLogger): { meta: SessionMeta; plan: LegacyPlanState } | null {
  const sessions = listSessions(baseDir, logger);
  if (sessions.length === 0) return null;
  return loadSession(sessions[0].id, baseDir, logger);
}

export function deleteSession(sessionId: string, baseDir?: string, logger: ILogger = defaultLogger): boolean {
  const sessionsDir = getSessionsDir(baseDir);
  if (!fs.existsSync(sessionsDir)) return false;
  try {
    const file = findSessionFile(sessionsDir, sessionId, logger);
    if (file) { fs.unlinkSync(path.join(sessionsDir, file)); return true; }
  } catch (err: unknown) {
    logger.warn('sessionStore', `failed to list sessions directory for deletion of ${sessionId}`, err);
  }
  return false;
}
