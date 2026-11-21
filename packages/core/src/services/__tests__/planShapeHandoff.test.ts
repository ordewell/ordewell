import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { openTaskLog } from '../../utils/taskLogStore';
import { FakeWorktreeIsolation } from '../../testing';
import { fanOutShape, sliceNote, withShapeNotes } from '../PlanFanOut';
import { makeSession, FakeRunnerSession, fakeConfig } from './sessionTestKit';

/**
 * The opening task's note promises the slices a module map at the end of its
 * report, and the slice's note tells it to read that report. A report reaches
 * no dependent's prompt, so the promise holds only if a slice, a change task,
 * can pull it with read, include_report, from a task it waits for through
 * others: in the measured shape the opening task is a dependency of a
 * dependency.
 */
const t = (id: string, order: number, deps: string[]): Task =>
  createTask({ id, order, title: `T ${id}`, prompt: `Fill in src/lib/${id}.py.`, dependencies: deps, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK' });

describe('the module map the opening task leaves in its report', () => {
  it('is read by a slice, through the shared modules it waits for', async () => {
    const slices = ['s1', 's2', 's3', 's4'];
    const written = [
      t('r', 1, []), t('m1', 2, ['r']), t('m2', 3, ['r']),
      ...slices.map((id, i) => t(id, 4 + i, ['m1', 'm2'])),
      t('close', 8, slices),
    ];
    const shape = fanOutShape(written);
    const plan = withShapeNotes(written);
    // The shared modules every slice waits for run before the fan-out too; only the first is the opening task.
    expect(shape.gates.map((g) => g.id)).toEqual(['r', 'm1', 'm2']);
    expect(shape.opening?.id).toBe('r');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-shape-handoff-'));
    const agents: FakeRunnerSession[] = [];
    const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const agent = new FakeRunnerSession(`a${agents.length + 1}`, opts.taskId);
      agents.push(agent);
      return agent;
    });
    const spawned = (taskId: string) => spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0];
    const agentOf = (taskId: string) => agents.find((a) => a.taskId === taskId)!;
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true }), isolation: new FakeWorktreeIsolation(),
      workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 },
    });
    try {
      session.loadPlan({ tasks: plan, generatedAt: '', lastUpdated: '', status: 'approved', runners: ['claude-code'] }, 'Fill in the library', root);
      await session.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(spawned('r')).toBeDefined());
      agentOf('r').reportComplete({
        status: 'done',
        summary: 'The package imports and its tests collect. The module map is in my report.',
        report: 'MODULE_MAP: src/lib/s1.py exports parse(), owned by "T s1" (s1).',
      });
      await vi.waitFor(() => expect(spawned('m2')).toBeDefined());
      agentOf('m1').reportComplete({ status: 'done', summary: 'Shared module one.' });
      agentOf('m2').reportComplete({ status: 'done', summary: 'Shared module two.' });
      await vi.waitFor(() => expect(spawned('s1')).toBeDefined());

      const slice = spawned('s1')!;
      expect(slice.prompt).toContain(sliceNote(shape, written.find((x) => x.id === 's1')));
      expect(slice.prompt).toContain('that start once "T r" (r), "T m1" (m1) and "T m2" (m2) have landed');
      expect(slice.prompt).not.toContain('MODULE_MAP');
      const handoff = (await slice.readTask!({ task: 'r', include_report: true })).text;
      expect(handoff).toContain('The module map is in my report.');
      expect(handoff).toContain('MODULE_MAP: src/lib/s1.py exports parse(), owned by "T s1" (s1).');
    } finally {
      session.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
