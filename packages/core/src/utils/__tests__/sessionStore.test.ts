import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveSession, listSessions, loadSession, loadSessionPlanState, getLatestSession, deleteSession } from '../sessionStore';
import { createEmptyPlan, createTask } from '../../models/Task';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type { ILogger } from '../../interfaces/ILogger';

function fakeLogger(): { logger: ILogger; warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    logger: {
      warn: (_ctx: string, msg: string) => { warns.push(msg); },
    },
  };
}

describe('sessionStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveSession', () => {
    it('writes a session file and returns meta with runners array', () => {
      const plan = createEmptyPlan();
      plan.runners = ['claude-code', 'opencode'];
      plan.tasks = [];
      plan.generatedAt = new Date().toISOString();

      const meta = saveSession(plan, 'Test goal', tmpDir);

      expect(meta.goal).toBe('Test goal');
      expect(meta.runners).toEqual(['claude-code', 'opencode']);

      const loaded = loadSession(meta.id, tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.plan.runners).toEqual(['claude-code', 'opencode']);
    });
  });

  describe('state-directory ignore file', () => {
    /** Every path under `dir`, relative and sorted, with its contents. */
    function tree(dir: string): Record<string, string> {
      const out: Record<string, string> = {};
      const walk = (abs: string, rel: string): void => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const childAbs = path.join(abs, entry.name);
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(childAbs, childRel);
          else out[childRel] = fs.readFileSync(childAbs, 'utf-8');
        }
      };
      walk(dir, '');
      return out;
    }

    function planFixture() {
      const plan = createEmptyPlan();
      plan.runners = ['claude-code'];
      plan.tasks = [];
      plan.generatedAt = new Date().toISOString();
      return plan;
    }

    it('writes a match-everything ignore file inside the state directory on first save', () => {
      saveSession(planFixture(), 'Goal', tmpDir);

      expect(fs.readFileSync(path.join(tmpDir, '.ordewell', '.gitignore'), 'utf-8')).toBe('*\n');
    });

    it('creates and modifies nothing outside the state directory', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello');

      saveSession(planFixture(), 'Goal', tmpDir);

      const after = tree(tmpDir);
      const outside = Object.keys(after).filter((p) => !p.startsWith('.ordewell/'));
      expect(outside.sort()).toEqual(['.gitignore', 'README.md']);
      expect(after['.gitignore']).toBe('node_modules/\ndist/\n');
      expect(after['README.md']).toBe('hello');
    });

    it('is idempotent and never overwrites a customised ignore file', () => {
      saveSession(planFixture(), 'First', tmpDir);

      const ignorePath = path.join(tmpDir, '.ordewell', '.gitignore');
      fs.writeFileSync(ignorePath, '# mine: commit the plans, ignore the rest\nsessions/\n');

      saveSession(planFixture(), 'Second', tmpDir);
      saveSession(planFixture(), 'Third', tmpDir);

      expect(fs.readFileSync(ignorePath, 'utf-8')).toBe('# mine: commit the plans, ignore the rest\nsessions/\n');
    });
  });

  describe('listSessions', () => {
    it('rejects old sessions with scalar runner at meta level', () => {
      const sessionsDir = path.join(tmpDir, '.ordewell', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const oldSession = {
        meta: { id: 'old-id', goal: 'old', runner: 'claude-code', taskCount: 1, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        plan: { tasks: [], generatedAt: new Date().toISOString(), status: 'draft', runners: [], lastUpdated: new Date().toISOString() },
      };
      fs.writeFileSync(path.join(sessionsDir, 'old.json'), JSON.stringify(oldSession));

      const { logger, warns } = fakeLogger();
      const sessions = listSessions(tmpDir, logger);

      expect(sessions).toHaveLength(0);
      expect(warns.some(w => w.includes('older version'))).toBe(true);
    });

    it('rejects old sessions with scalar runner at plan level', () => {
      const sessionsDir = path.join(tmpDir, '.ordewell', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const oldSession = {
        meta: { id: 'old-id2', goal: 'old', runners: [], taskCount: 1, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        plan: { tasks: [], generatedAt: new Date().toISOString(), status: 'draft', runner: 'claude-code', lastUpdated: new Date().toISOString() },
      };
      fs.writeFileSync(path.join(sessionsDir, 'old2.json'), JSON.stringify(oldSession));

      const { logger, warns } = fakeLogger();
      const sessions = listSessions(tmpDir, logger);

      expect(sessions).toHaveLength(0);
      expect(warns.some(w => w.includes('older version'))).toBe(true);
    });

    it('loads valid sessions with runners array', () => {
      const plan = createEmptyPlan();
      plan.runners = ['opencode'];
      saveSession(plan, 'valid', tmpDir);

      const { logger, warns } = fakeLogger();
      const sessions = listSessions(tmpDir, logger);

      expect(sessions).toHaveLength(1);
      expect(sessions[0].runners).toEqual(['opencode']);
      expect(warns).toHaveLength(0);
    });
  });

  describe('loadSession', () => {
    it('returns null for old sessions with scalar runner at meta level', () => {
      const sessionsDir = path.join(tmpDir, '.ordewell', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const oldSession = {
        meta: { id: 'reject-me', goal: 'old', runner: 'claude-code', taskCount: 1, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        plan: { tasks: [], generatedAt: new Date().toISOString(), status: 'draft', runners: [], lastUpdated: new Date().toISOString() },
      };
      fs.writeFileSync(path.join(sessionsDir, 'reject.json'), JSON.stringify(oldSession));

      const { logger, warns } = fakeLogger();
      const result = loadSession('reject-me', tmpDir, logger);

      expect(result).toBeNull();
      expect(warns.some(w => w.includes('older version'))).toBe(true);
    });

    it('returns null for old sessions with scalar runner at plan level', () => {
      const sessionsDir = path.join(tmpDir, '.ordewell', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const oldSession = {
        meta: { id: 'reject-me2', goal: 'old', runners: [], taskCount: 1, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        plan: { tasks: [], generatedAt: new Date().toISOString(), status: 'draft', runner: 'opencode', lastUpdated: new Date().toISOString() },
      };
      fs.writeFileSync(path.join(sessionsDir, 'reject2.json'), JSON.stringify(oldSession));

      const { logger, warns } = fakeLogger();
      const result = loadSession('reject-me2', tmpDir, logger);

      expect(result).toBeNull();
      expect(warns.some(w => w.includes('older version'))).toBe(true);
    });

    it('loads valid session with runners array', () => {
      const plan = createEmptyPlan();
      plan.runners = ['opencode'];
      const meta = saveSession(plan, 'load me', tmpDir);

      const result = loadSession(meta.id, tmpDir);

      expect(result).not.toBeNull();
      expect(result!.plan.runners).toEqual(['opencode']);
      expect(result!.meta.runners).toEqual(['opencode']);
    });
  });

  describe('getLatestSession', () => {
    it('skips old sessions and returns the latest valid one', () => {
      const sessionsDir = path.join(tmpDir, '.ordewell', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const oldSession = {
        meta: { id: 'oldest', goal: 'old', runner: 'claude-code', taskCount: 1, status: 'draft', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
        plan: { tasks: [], generatedAt: '2020-01-01T00:00:00.000Z', status: 'draft', runners: [], lastUpdated: '2020-01-01T00:00:00.000Z' },
      };
      fs.writeFileSync(path.join(sessionsDir, '1_old_oldest.json'), JSON.stringify(oldSession));

      const plan = createEmptyPlan();
      plan.runners = ['claude-code', 'opencode'];
      saveSession(plan, 'newer', tmpDir);

      const { logger } = fakeLogger();
      const result = getLatestSession(tmpDir, logger);

      expect(result).not.toBeNull();
      expect(result!.meta.runners).toEqual(['claude-code', 'opencode']);
    });
  });

  describe('deleteSession', () => {
    it('deletes a saved session', () => {
      const plan = createEmptyPlan();
      const meta = saveSession(plan, 'delete me', tmpDir);

      expect(loadSession(meta.id, tmpDir)).not.toBeNull();

      const result = deleteSession(meta.id, tmpDir);
      expect(result).toBe(true);
      expect(loadSession(meta.id, tmpDir)).toBeNull();
    });

    it('returns false for nonexistent session', () => {
      expect(deleteSession('no-such-id', tmpDir)).toBe(false);
    });
  });

  describe('loadSessionPlanState', () => {
    it('loads and migrates a session to planning phase PlanState', () => {
      const plan = createEmptyPlan();
      plan.tasks = [];
      plan.runners = ['claude-code'];
      plan.conversationHistory = [
        { role: 'user', content: 'build feature X', timestamp: new Date().toISOString() },
      ];
      const meta = saveSession(plan, 'test plan', tmpDir);

      const result = loadSessionPlanState(meta.id, tmpDir);
      expect(result).not.toBeNull();
      expect(result!.plan.phase).toBe('planning');
      expect(result!.meta.goal).toBe('test plan');
      if (result!.plan.phase === 'planning') {
        expect(result!.plan.pendingTasks).toEqual([]);
      }
    });

    it('loads and migrates a session with completed tasks to executing phase', () => {
      const plan = createEmptyPlan();
      plan.tasks = [
        createTask({ id: 'done', title: 'Done task', status: 'completed' }),
        createTask({ id: 'todo', title: 'Todo task', status: 'pending' }),
      ];
      plan.runners = ['opencode'];
      plan.status = 'running';
      const meta = saveSession(plan, 'executing session', tmpDir);

      const result = loadSessionPlanState(meta.id, tmpDir);
      expect(result).not.toBeNull();
      expect(result!.plan.phase).toBe('executing');
      if (result!.plan.phase === 'executing') {
        expect(result!.plan.executionLog).toHaveLength(1);
        expect(result!.plan.executionLog[0].id).toBe('done');
        expect(result!.plan.executionLog[0].status).toBe('completed');
        expect(result!.plan.pendingTasks).toHaveLength(1);
        expect(result!.plan.pendingTasks[0].id).toBe('todo');
      }
    });

    it('returns null for nonexistent session', () => {
      const result = loadSessionPlanState('no-such-id', tmpDir);
      expect(result).toBeNull();
    });

    it('preserves queuedMessages as history in migrated PlanState', () => {
      const plan = createEmptyPlan();
      plan.queuedMessages = [
        { id: 'qm1', text: 'add more tests', timestamp: '2024-01-01T00:00:00.000Z' },
      ];
      plan.tasks = [];
      plan.status = 'draft';
      const meta = saveSession(plan, 'history test', tmpDir);

      const result = loadSessionPlanState(meta.id, tmpDir);
      expect(result).not.toBeNull();
      expect(result!.plan.history.length).toBeGreaterThanOrEqual(1);
    });
  });
});
