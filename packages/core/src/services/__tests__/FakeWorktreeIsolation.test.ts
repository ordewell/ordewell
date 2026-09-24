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
    for (const order of [1, 2, 3]) await iso.prepare(task(order), run);
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

  // Scheduling tests trust the fake to settle records the way git does.
  it('fails an integration nothing prepared, as the real module does', async () => {
    const iso = new FakeWorktreeIsolation();
    const run = await iso.startRun('/ws');
    expect(await iso.integrate(task(1), run)).toBe('failed');
  });

  it('moves a kept release off active and drops a discarded one', async () => {
    const iso = new FakeWorktreeIsolation();
    const run = await iso.startRun('/ws');
    await iso.prepare(task(1), run);
    await iso.prepare(task(2), run);

    await iso.release(run, 'task-1', { keep: true });
    await iso.release(run, 'task-2', { keep: false });

    expect(run.tasks['task-1']?.status).toBe('kept');
    expect(run.tasks['task-2']).toBeUndefined();
  });

  it('reports the availability it is given', async () => {
    const iso = new FakeWorktreeIsolation();
    iso.availability = { active: false, reason: 'dirty' };
    expect(await iso.isActive('/ws')).toEqual({ active: false, reason: 'dirty' });
  });
});
