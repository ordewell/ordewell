import { describe, it, expect } from 'vitest';
import { FakeWorktreeIsolation } from '../../testing';
import type { Task } from '../../models/Task';

const task = (order: number): Task => ({
  id: `task-${order}`, order, title: `Task ${order}`, description: '', type: 'ai', status: 'approved',
  dependencies: [], subtasks: [], assignedRunner: 'claude-code', completionMarker: 'DONE',
});

describe('FakeWorktreeIsolation', () => {
  it('hands out a per-task cwd and records the call order', async () => {
    const iso = new FakeWorktreeIsolation();
    const run = await iso.startRun('/ws');
    const { cwd } = await iso.prepare(task(2), run);
    await iso.prepare(task(1), run);
    expect(cwd).toBe('/fake-worktrees/run1/2-task-2');
    expect(iso.taskIdsFor('prepare')).toEqual(['task-2', 'task-1']);
  });

  it('integrates as merged unless scripted, and can hold an integration open', async () => {
    const iso = new FakeWorktreeIsolation();
    const run = await iso.startRun('/ws');
    iso.outcomes.set('task-2', 'conflict');
    expect(await iso.integrate(task(1), run)).toBe('merged');
    expect(await iso.integrate(task(2), run)).toBe('conflict');

    const open = iso.holdIntegration('task-3');
    let settled = false;
    const pending = iso.integrate(task(3), run).then((o) => { settled = true; return o; });
    await Promise.resolve();
    expect(settled).toBe(false);
    open();
    expect(await pending).toBe('merged');
  });

  it('reports the availability it is given', async () => {
    const iso = new FakeWorktreeIsolation();
    iso.availability = { active: false, reason: 'dirty' };
    expect(await iso.isActive('/ws')).toEqual({ active: false, reason: 'dirty' });
  });
});
