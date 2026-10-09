import { describe, it, expect } from 'vitest';
import { FakeWorktreeIsolation } from '../../testing';
import type { Task } from '../../models/Task';

const task = (order: number): Task => ({
  id: `task-${order}`, order, title: `Task ${order}`, description: '', type: 'ai', status: 'approved',
  dependencies: [], subtasks: [], assignedRunner: 'claude-code',
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

  it('reopens a conflicted task for a repair the way git does, and settles it back on release', async () => {
    const iso = new FakeWorktreeIsolation();
    const run = await iso.startRun('/ws');
    const { cwd } = await iso.prepare(task(1), run);
    await expect(iso.reopen(task(1), run)).rejects.toThrow(/no conflict/);
    iso.outcomes.set('task-1', 'conflict');
    iso.conflictFiles.set('task-1', ['a.ts']);
    await iso.integrate(task(1), run);

    expect(await iso.reopen(task(1), run)).toEqual({ cwd, branch: 'ordewell/run1/1-task-1', copied: [] });
    expect(run.tasks['task-1']).toMatchObject({ status: 'repairing', repairs: 1, repairBase: { '.': 'tip-.' }, repairedFiles: ['a.ts'] });
    expect(await iso.verifyRepair(task(1), run)).toEqual({ ok: true });
    iso.repairEvidence.set('task-1', { ok: false, reason: 'not-merged', repo: '.' });
    expect(await iso.verifyRepair(task(1), run)).toEqual({ ok: false, reason: 'not-merged', repo: '.' });

    await iso.release(run, 'task-1', { keep: true });
    expect(run.tasks['task-1']).toMatchObject({ status: 'conflict', repairs: 1 });
    expect(run.tasks['task-1'].repairBase).toBeUndefined();
    expect(iso.taskIdsFor('reopen')).toEqual(['task-1', 'task-1']);
  });

  it('reports the availability it is given', async () => {
    const iso = new FakeWorktreeIsolation();
    iso.availability = { active: false, reason: 'dirty' };
    expect(await iso.isActive('/ws')).toEqual({ active: false, reason: 'dirty' });
  });
});
