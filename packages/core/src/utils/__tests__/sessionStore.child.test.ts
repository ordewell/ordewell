import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { deleteSession, listChildSessions, listSessions, loadChildSession, saveChildSession, saveSession, sessionDataDir, type ChildSessionPlace } from '../sessionStore';
import { openTaskLog, readTaskLog, saveTaskPatch } from '../taskLogStore';
import type { LegacyPlanState } from '../../models/Task';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-store-')));
  roots.push(dir);
  return dir;
}

const plan = (): LegacyPlanState => ({ tasks: [], runners: ['claude-code'], status: 'pending', generatedAt: '2026-10-31T10:00:00.000Z' } as unknown as LegacyPlanState);

describe('a child session under its root (ADR-0055 D11)', () => {
  it('keeps its file, research log and task logs at sessions/<root>/children/<child>/', () => {
    const baseDir = workspace();
    const place: ChildSessionPlace = { baseDir, rootSessionId: 'session-root', sessionId: 'session-child' };
    saveChildSession({ ...plan(), researchLog: [{ query: 'q' }] } as unknown as LegacyPlanState, 'a goal', place);
    openTaskLog(place, 't1').append([{ type: 'text', text: 'hi' } as never]);
    saveTaskPatch(place, 't1', 1, Buffer.from('diff'));

    const dir = join(baseDir, '.ordewell', 'sessions', 'session-root', 'children', 'session-child');
    expect(relative(baseDir, sessionDataDir('session-child', baseDir, 'session-root'))).toBe(join('.ordewell', 'sessions', 'session-root', 'children', 'session-child'));
    expect(readdirSync(dir).sort()).toEqual(['research-log.json', 'session.json', 'tasks']);
    expect(readdirSync(join(dir, 'tasks', 't1')).sort()).toEqual(['1.jsonl', '1.patch']);
    expect(readTaskLog(place, 't1', 1)).toHaveLength(1);
  });

  it('reads back through its root, in-progress tasks failed as a load fails them', () => {
    const baseDir = workspace();
    const place = { baseDir, rootSessionId: 'session-root', sessionId: 'session-child' };
    saveChildSession({ ...plan(), tasks: [{ id: 't1', order: 1, title: 'T', status: 'in_progress', dependencies: [], subtasks: [] }], researchLog: [{ query: 'q' }] } as unknown as LegacyPlanState, 'a goal', place);
    const loaded = loadChildSession(place);
    expect(loaded?.meta).toMatchObject({ id: 'session-child', goal: 'a goal' });
    expect(loaded?.plan.tasks[0].status).toBe('failed');
    expect(loaded?.plan.researchLog).toEqual([{ query: 'q' }]);
    expect(loadChildSession({ ...place, sessionId: 'session-none' })).toBeNull();
  });

  it('is never in the list of sessions, and goes with its root', () => {
    const baseDir = workspace();
    saveSession(plan(), 'the root', baseDir, 'session-root');
    saveChildSession(plan(), 'a child', { baseDir, rootSessionId: 'session-root', sessionId: 'session-a' });
    saveChildSession(plan(), 'its child', { baseDir, rootSessionId: 'session-root', sessionId: 'session-b' });

    expect(listSessions(baseDir).map((s) => s.id)).toEqual(['session-root']);
    expect(listChildSessions('session-root', baseDir).sort()).toEqual(['session-a', 'session-b']);
    expect(listChildSessions('session-none', baseDir)).toEqual([]);

    expect(deleteSession('session-root', baseDir)).toBe(true);
    expect(existsSync(sessionDataDir('session-root', baseDir))).toBe(false);
    expect(listChildSessions('session-root', baseDir)).toEqual([]);
  });

  it('a hostile child id stays inside its root\'s directory', () => {
    const baseDir = workspace();
    const place = { baseDir, rootSessionId: 'session-root', sessionId: '../../../evil' };
    saveChildSession(plan(), 'a child', place);
    expect(existsSync(join(baseDir, '.ordewell', 'evil'))).toBe(false);
    expect(relative(sessionDataDir('session-root', baseDir), sessionDataDir(place.sessionId, baseDir, place.rootSessionId)).startsWith('children')).toBe(true);
    expect(loadChildSession(place)?.meta.id).toBe(place.sessionId);
  });
});
