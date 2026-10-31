import * as fs from 'fs';
import * as path from 'path';
import type { LegacyPlanState, PlanState } from '../models/Task';
import { dropRetiredPlanFields, failInterruptedTasks, migratePlanState, migrateLoadedTasks } from '../models/Task';
import { migratePlanStateIsolation } from '../services/isolationRecord';
import type { SessionMeta, SessionData } from '../models/Session';
import { defaultLogger, type ILogger } from '../interfaces/ILogger';
import { getStateDir, ensureDir, ensureStateDirIgnored, writeFileAtomic } from './fsHelpers';
import { mintSessionId } from './sessionId';

const SESSIONS_SUBDIR = 'sessions';

function getSessionsDir(baseDir?: string): string {
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

/**
 * The directory beside a session's file for what it keeps outside that file —
 * its task logs (ADR-0018, P1). It goes when the session does.
 */
export function sessionDataDir(sessionId: string, baseDir?: string): string {
  return path.join(getSessionsDir(baseDir), idSegment(sessionId));
}

const REJECTION_MESSAGE = 'This session was created with an older version of Ordewell. Please re-plan.';

/** A file is listed only when it carries the header every surface reads; a parsed object is not enough. */
function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Record<string, unknown>;
  return typeof meta.id === 'string' && meta.id !== ''
    && typeof meta.createdAt === 'string' && !Number.isNaN(Date.parse(meta.createdAt));
}

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
  dropRetiredPlanFields(session.plan);

  const filename = sessionFilename(meta);
  const filePath = path.join(sessionsDir, filename);

  writeFileAtomic(filePath, JSON.stringify(session, null, 2));
  dropLegacyFile(sessionsDir, meta);

  return meta;
}

export function listSessions(baseDir?: string, logger: ILogger = defaultLogger): SessionMeta[] {
  const sessionsDir = getSessionsDir(baseDir);
  if (!fs.existsSync(sessionsDir)) return [];

  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));

  return files
    .map((f) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
      } catch (err: unknown) {
        // Only unparseable content is moved aside: an I/O error (EACCES, EMFILE)
        // says nothing about the file, and renaming a good session would hide it
        // from every surface long after the error cleared.
        if (err instanceof SyntaxError) return moveAside(sessionsDir, f, 'is not valid JSON', logger);
        logger.warn('sessionStore', `failed to read session file ${f}; skipping`, err);
        return null;
      }
      if (!parsed || typeof parsed !== 'object') {
        return moveAside(sessionsDir, f, 'is not a session: no usable id and creation time', logger);
      }
      if (hasScalarRunner(parsed as Record<string, unknown>)) {
        logger.warn('sessionStore', `session file ${f}: ${REJECTION_MESSAGE}`);
        return null;
      }
      const session = parsed as SessionData;
      if (!isSessionMeta(session.meta)) return moveAside(sessionsDir, f, 'is not a session: no usable id and creation time', logger);
      return session.meta;
    })
    .filter((m): m is SessionMeta => m !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * A file that will not parse is not merely skipped: every surface would show
 * the session gone with no explanation. It is renamed out of the `.json` set
 * so the loss is visible and the bytes are kept for inspection — never deleted,
 * since they may be all that is left of the user's work.
 */
function moveAside(sessionsDir: string, file: string, reason: string, logger: ILogger): null {
  const aside = `${file}.${Date.now()}.corrupt`;
  try {
    fs.renameSync(path.join(sessionsDir, file), path.join(sessionsDir, aside));
    logger.warn('sessionStore', `session file ${file} ${reason}; moved aside to ${aside} rather than overwritten`);
  } catch {
    logger.warn('sessionStore', `failed to read session file ${file}; skipping`);
  }
  return null;
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
      failInterruptedTasks(plan.tasks, new Date().toISOString());
      migratePlanStateIsolation(plan);
      migrateLoadedTasks(plan.tasks);
      dropRetiredPlanFields(plan);
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
    fs.rmSync(sessionDataDir(sessionId, baseDir), { recursive: true, force: true });
  } catch (err: unknown) {
    logger.warn('sessionStore', `failed to remove the task logs of ${sessionId}`, err);
  }
  try {
    const file = findSessionFile(sessionsDir, sessionId, logger);
    if (file) { fs.unlinkSync(path.join(sessionsDir, file)); return true; }
  } catch (err: unknown) {
    logger.warn('sessionStore', `failed to list sessions directory for deletion of ${sessionId}`, err);
  }
  return false;
}
