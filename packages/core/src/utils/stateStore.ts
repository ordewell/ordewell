import * as fs from 'fs';
import * as path from 'path';
import { dropRetiredPlanFields, failInterruptedTasks, LegacyPlanState, migrateLoadedTasks, settleOwedRepairs } from '../models/Task';
import { defaultLogger, type ILogger } from '../interfaces/ILogger';
import { getStateDir, ensureDir, writeFileAtomic } from './fsHelpers';
import { migratePlanStateIsolation } from '../services/isolationRecord';

const STATE_FILE = 'state.json';

function getStatePath(baseDir: string): string {
  return path.join(getStateDir(baseDir), STATE_FILE);
}

/**
 * The restore state a surface reopens on start. The session id sits beside the
 * plan, not on it, so it never travels into a session file's `plan`; without
 * it a restore would persist under a freshly minted id and fork the session.
 */
export interface SavedState {
  plan: LegacyPlanState;
  /** Absent in a state file written before the id was kept. */
  sessionId?: string;
}

const SESSION_ID_KEY = 'sessionId';

export function saveState(plan: LegacyPlanState, baseDir?: string, sessionId?: string): void {
  const statePath = getStatePath(baseDir ?? process.cwd());
  ensureDir(path.dirname(statePath));
  plan.lastUpdated = new Date().toISOString();
  const file = sessionId ? { ...plan, [SESSION_ID_KEY]: sessionId } : plan;
  dropRetiredPlanFields(file);
  writeFileAtomic(statePath, JSON.stringify(file, null, 2));
}

export function loadState(baseDir?: string, logger: ILogger = defaultLogger): SavedState | null {
  const dir = baseDir ?? process.cwd();
  const statePath = getStatePath(dir);
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.runners)) {
      logger.warn('stateStore', `rejecting state from ${statePath}: old format (scalar "runner" instead of "runners" array). Please re-plan.`);
      return null;
    }
    const sessionId: unknown = parsed[SESSION_ID_KEY];
    delete parsed[SESSION_ID_KEY];
    const plan = parsed as LegacyPlanState;
    failInterruptedTasks(plan.tasks, new Date().toISOString());
    migratePlanStateIsolation(plan);
    settleOwedRepairs(plan);
    migrateLoadedTasks(plan.tasks);
    dropRetiredPlanFields(plan);
    return typeof sessionId === 'string' && sessionId ? { plan, sessionId } : { plan };
  } catch (err: unknown) {
    logger.warn('stateStore', `failed to load state from ${statePath}; falling back to empty state`, err);
    return null;
  }
}

export function clearState(baseDir?: string): void {
  const dir = baseDir ?? process.cwd();
  const statePath = getStatePath(dir);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
}

export function stateExists(baseDir?: string): boolean {
  const dir = baseDir ?? process.cwd();
  return fs.existsSync(getStatePath(dir));
}
