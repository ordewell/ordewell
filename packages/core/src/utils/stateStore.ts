import * as fs from 'fs';
import * as path from 'path';
import { LegacyPlanState } from '../models/Task';
import { defaultLogger, type ILogger } from '../interfaces/ILogger';
import { getStateDir, ensureDir } from './fsHelpers';

const STATE_FILE = 'state.json';

function getStatePath(baseDir: string): string {
  return path.join(getStateDir(baseDir), STATE_FILE);
}

export function saveState(plan: LegacyPlanState, baseDir?: string): void {
  const statePath = getStatePath(baseDir ?? process.cwd());
  ensureDir(path.dirname(statePath));
  plan.lastUpdated = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(plan, null, 2));
}

export function loadState(baseDir?: string, logger: ILogger = defaultLogger): LegacyPlanState | null {
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
    return parsed as LegacyPlanState;
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
