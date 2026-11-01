import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { openTaskLog } from '../../utils/taskLogStore';
import { FakeWorktreeIsolation } from '../../testing';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig } from './sessionTestKit';

describe('a loop handoff through Session and the attempt logs (ADR-0047)', () => {
  it('reads its own last attempt in full before opening the next attempt log', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-loop-handoff-'));
    const agents: FakeRunnerSession[] = [];
    const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const agent = new FakeRunnerSession(`s${agents.length + 1}`, opts.taskId);
      agents.push(agent);
      return agent;
    });
    const session = makeSession({ workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } });
    try {
      session.loadPlan({
        tasks: [
          createTask({ id: 'check', order: 1, title: 'Check', prompt: 'Review.', loop: { body: ['fix'], maxRounds: 3 } }),
          createTask({ id: 'fix', order: 2, title: 'Fix', prompt: 'Fix.', dependencies: ['check'] }),
        ],
        generatedAt: '2026-10-22T00:00:00Z', lastUpdated: '2026-10-22T00:00:00Z', status: 'approved', runners: ['claude-code'],
      }, 'Review and fix', root);
      await session.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(agents).toHaveLength(1));
      agents[0].reportComplete({ status: 'failed', summary: 'Many holes.', findings: Array.from({ length: 26 }, (_, i) => ({ severity: 'major', title: `Hole ${i + 1}` })), report: 'The long report stays out.' });
      await vi.waitFor(() => expect(agents).toHaveLength(2));
      expect(taskOf(session, 'check')?.handoff?.findings).toHaveLength(25);
      agents[1].reportComplete({ status: 'done', summary: 'Closed all holes.' });
      await vi.waitFor(() => expect(agents).toHaveLength(3));

      const prompt = spawn.mock.calls[2][0].prompt!;
      expect(prompt).toContain('F26 [major] Hole 26');
      expect(prompt).toContain('Closed all holes.');
      expect(prompt).not.toContain('The long report stays out.');
      agents[2].reportComplete({ status: 'done', summary: 'Verified.' });
      await vi.waitFor(() => expect(taskOf(session, 'check')?.status).toBe('completed'));
    } finally {
      session.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it('a restarted run exposes no old result as the running attempt handoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-restart-handoff-'));
  const agents: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const agent = new FakeRunnerSession(`s${agents.length + 1}`, opts.taskId);
    agents.push(agent);
    return agent;
  });
  const session = makeSession({ workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } });
  try {
    session.loadPlan({ tasks: [createTask({ id: 'a', order: 1, prompt: 'Review' })], generatedAt: '', lastUpdated: '', status: 'approved', runners: ['claude-code'] }, 'Review', root);
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    agents[0].reportComplete({ status: 'failed', summary: 'OLD_ATTEMPT_SENTINEL', findings: [{ severity: 'major', title: 'Old hole' }] });
    await vi.waitFor(() => expect(taskOf(session, 'a')?.status).toBe('failed'));
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(agents).toHaveLength(2));
    expect(taskOf(session, 'a')?.handoff).toBeUndefined();
    const read = spawn.mock.calls[1][0].readTask!;
    expect((await read({ task: 'a' })).text).not.toContain('OLD_ATTEMPT_SENTINEL');
    expect((await read({ task: 'a', attempt: 1 })).text).toContain('OLD_ATTEMPT_SENTINEL');
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('a dependent pulls the repair result from attempt 2 after a conflicting landing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-repair-handoff-'));
  const isolation = new FakeWorktreeIsolation();
  isolation.outcomes.set('a', 'conflict');
  const agents: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const agent = new FakeRunnerSession(`s${agents.length + 1}`, opts.taskId);
    agents.push(agent);
    return agent;
  });
  const session = makeSession({ config: fakeConfig({ worktreeIsolation: true, conflictRepairAttempts: 2 }), isolation, workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } });
  try {
    session.loadPlan({ tasks: [createTask({ id: 'a', order: 1, prompt: 'Build' }), createTask({ id: 'b', order: 2, prompt: 'Read', dependencies: ['a'] })], generatedAt: '', lastUpdated: '', status: 'approved', runners: ['claude-code'] }, 'Build and read', root);
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    agents[0].reportComplete({ status: 'done', summary: 'Original result', report: 'Original report' });
    await vi.waitFor(() => expect(agents).toHaveLength(2));
    isolation.outcomes.set('a', 'merged');
    agents[1].reportComplete({ status: 'done', summary: 'Repair result', findings: [{ severity: 'info', title: 'Repaired' }], report: 'Repair report' });
    await vi.waitFor(() => expect(agents).toHaveLength(3));
    const read = spawn.mock.calls[2][0].readTask!;
    const latest = (await read({ task: 'a', include_report: true })).text;
    expect(latest).toContain('attempt 2 of 2');
    expect(latest).toContain('Repair result');
    expect(latest).toContain('F1 [info] Repaired');
    expect(latest).toContain('Repair report');
    expect(latest).not.toContain('Original report');
    expect((await read({ task: 'a', attempt: 1, include_report: true })).text).toContain('Original report');
  } finally {
    session.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
