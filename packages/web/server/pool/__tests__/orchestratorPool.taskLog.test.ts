import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readTaskLog, saveSession, type ITerminalRunner, type LegacyPlanState, type RunnerSpawnOptions } from '@ordewell/core';
import { FakeStructuredSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['claude-code'],
    generatedAt: '2026-09-29T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks: [], prompt: 'do it' },
    ],
  } as unknown as LegacyPlanState;
}

/** A structured task's log (ADR-0018, P1) from the daemon's side: saved under the session, streamed to its sockets. */
describe('OrchestratorPool task logs', () => {
  let workspace: string;
  let settingsDir: string;
  let savedSettingsPath: string | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-tasklog-'));
    mkdirSync(join(workspace, '.git'));
    settingsDir = mkdtempSync(join(tmpdir(), 'ordewell-pool-tasklog-settings-'));
    savedSettingsPath = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = join(settingsDir, 'settings.json');
  });

  afterEach(() => {
    if (savedSettingsPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedSettingsPath;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('streams a structured task’s events as task_log frames and saves them beside the session', async () => {
    const sessions: FakeStructuredSession[] = [];
    const structuredRunner: ITerminalRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const session = new FakeStructuredSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const runner: ITerminalRunner = { spawn: vi.fn().mockRejectedValue(new Error('terminal runner unused')), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
    const pool = new OrchestratorPool({ runner, structuredRunner });
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-tasklog');
    pool.adoptSavedSession(meta.id, workspace);
    const sent: string[] = [];
    pool.subscribe(meta.id, { OPEN: 1, readyState: 1, send: (data: string) => sent.push(data) } as never);

    await pool.session(meta.id).runTask('t1');
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].emitEvent({ type: 'turn_start', text: 'do it' });
    sessions[0].emitEvent({ type: 'assistant_text', text: 'Working on it.' });
    sessions[0].emitEvent({ type: 'turn_end', reason: 'completed' });

    const frames = () => sent.map((s) => JSON.parse(s) as { type: string; taskId?: string; attempt?: number; events?: unknown[] });
    await vi.waitFor(() => expect(frames().some((f) => f.type === 'task_log')).toBe(true));
    const logged = frames().filter((f) => f.type === 'task_log');
    expect(logged.every((f) => f.taskId === 't1' && f.attempt === 1)).toBe(true);
    const events = logged.flatMap((f) => f.events ?? []);
    expect(events).toEqual([
      { type: 'turn_start', message: 'do it' },
      { type: 'text', text: 'Working on it.' },
      { type: 'turn_end', reason: 'completed' },
    ]);
    expect(readTaskLog({ baseDir: workspace, sessionId: meta.id }, 't1', 1)).toEqual(events);
    pool.destroyAll();
  });
});
