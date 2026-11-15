import { describe, it, expect } from 'vitest';
import { carryPlannedModes, plannedMode, readOnlyMode, type RunnerModeInfo } from '../ModeResolver';
import { createTask } from '../../models/Task';
import { ORDEWELL_MANIFEST } from '../../plugins/builtin/ordewell.manifest';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { attemptModeOf } from '../harness/ordewell/modes';

const claude: RunnerModeInfo[] = [
  { id: 'default', label: 'Ask before edits', description: 'asks' },
  { id: 'auto', label: 'Auto', description: 'classifier', safe: true },
  { id: 'acceptEdits', label: 'Edit automatically', description: 'edits' },
  { id: 'plan', label: 'Plan mode', description: 'read-only', readOnly: true },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: 'skips prompts', autonomous: true },
];
const opencode: RunnerModeInfo[] = [
  { id: 'build', label: 'Build', description: 'full access', autonomous: true, safe: true },
  { id: 'plan', label: 'Plan', description: 'read-only', readOnly: true },
];
const noReadOnly: RunnerModeInfo[] = [
  { id: 'write', label: 'Write', description: 'writes', autonomous: true, safe: true },
  { id: 'plan', label: 'Plan', description: 'untagged' },
];
const runnerModes = { 'claude-code': claude, opencode, custom: noReadOnly };

describe('readOnlyMode', () => {
  it('is the mode the manifest tags readOnly, never one found by id', () => {
    expect(readOnlyMode(claude)).toBe('plan');
    expect(readOnlyMode(noReadOnly)).toBeUndefined();
    expect(readOnlyMode(undefined)).toBeUndefined();
  });
});

describe('plannedMode (ADR-0031)', () => {
  it('lands a new task on the level\'s mode', () => {
    expect(plannedMode('claude-code', runnerModes, {}, true)).toEqual({ ok: true, mode: 'bypassPermissions' });
    expect(plannedMode('claude-code', runnerModes, {}, false)).toEqual({ ok: true, mode: 'auto' });
    expect(plannedMode('claude-code', runnerModes, { readOnly: false }, false)).toEqual({ ok: true, mode: 'auto' });
  });

  it('lands a read-only task on the runner\'s read-only mode at either level', () => {
    expect(plannedMode('claude-code', runnerModes, { readOnly: true }, true)).toEqual({ ok: true, mode: 'plan' });
    expect(plannedMode('opencode', runnerModes, { readOnly: true }, false)).toEqual({ ok: true, mode: 'plan' });
  });

  it('refuses a read-only task on a runner without a read-only mode, naming those with one', () => {
    const result = plannedMode('custom', runnerModes, { readOnly: true }, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('"custom" has no read-only mode');
    expect(result.error).toContain('claude-code, opencode');
  });

  it('keeps a task\'s current mode when the planner asks for no change, so a hand-picked mode survives', () => {
    expect(plannedMode('claude-code', runnerModes, { current: 'default' }, true)).toEqual({ ok: true, mode: 'default' });
    expect(plannedMode('claude-code', runnerModes, { current: 'default', readOnly: false }, true)).toEqual({ ok: true, mode: 'default' });
    expect(plannedMode('claude-code', runnerModes, { current: 'plan' }, true)).toEqual({ ok: true, mode: 'plan' });
  });

  it('takes a read-only task off its read-only mode only when told readOnly: false', () => {
    expect(plannedMode('claude-code', runnerModes, { current: 'plan', readOnly: false }, false)).toEqual({ ok: true, mode: 'auto' });
  });

  it('replaces a current mode the runner does not offer with the level\'s mode', () => {
    expect(plannedMode('opencode', runnerModes, { current: 'bypassPermissions' }, true)).toEqual({ ok: true, mode: 'build' });
  });

  it('decides nothing for a runner whose modes it was not given', () => {
    expect(plannedMode('claude-code', undefined, { current: 'default' }, true)).toEqual({ ok: true, mode: undefined });
  });
});

describe('carryPlannedModes', () => {
  const catalog = { runnerModes, autonomousDefault: true };
  const task = (id: string, taskMode: string, assignedRunner = 'claude-code') => createTask({ id, title: id, prompt: id, assignedRunner, taskMode });

  it('keeps a matched task\'s writable mode when the restatement leaves it writable', () => {
    expect(carryPlannedModes([task('a', 'default')], [task('a', 'bypassPermissions')], catalog).map((t) => t.taskMode)).toEqual(['default']);
  });

  it('takes read-only from the restatement, either way', () => {
    expect(carryPlannedModes([task('a', 'default')], [task('a', 'plan')], catalog)[0].taskMode).toBe('plan');
    expect(carryPlannedModes([task('a', 'plan')], [task('a', 'bypassPermissions')], catalog)[0].taskMode).toBe('bypassPermissions');
  });

  it('leaves new tasks, manual tasks and modes the new runner lacks to the restatement', () => {
    const manual = { ...task('m', 'default'), type: 'user' as const };
    const [added, kept, moved] = carryPlannedModes(
      [manual, task('o', 'default')],
      [task('n', 'bypassPermissions'), { ...manual, taskMode: undefined }, task('o', 'build', 'opencode')],
      catalog,
    );
    expect([added.taskMode, kept.taskMode, moved.taskMode]).toEqual(['bypassPermissions', undefined, 'build']);
  });

  it('reaches subtasks', () => {
    const parent = (child: string) => ({ ...task('p', 'auto'), subtasks: [task('s', child)] });
    expect(carryPlannedModes([parent('acceptEdits')], [parent('bypassPermissions')], catalog)[0].subtasks[0].taskMode).toBe('acceptEdits');
  });
});

describe('the Ordewell runner\'s modes (ADR-0070)', () => {
  const modes = { ordewell: ORDEWELL_MANIFEST.modes ?? [] };
  /** The mode a planned task's attempt runs in, through the flags a spawn resolves from its manifest. */
  const attempt = (mode: string | undefined) => {
    if (mode === undefined) throw new Error('no mode planned');
    return attemptModeOf({ kind: 'task', cwd: '.', mode, flags: resolveTaskRunnerFlags(ORDEWELL_MANIFEST, { mode }) });
  };

  it('maps Full and Guarded onto its full and guarded modes, and a read-only task onto read-only at either level', () => {
    const full = plannedMode('ordewell', modes, {}, true);
    const guarded = plannedMode('ordewell', modes, {}, false);
    expect([full, guarded]).toEqual([{ ok: true, mode: 'full' }, { ok: true, mode: 'guarded' }]);
    expect(plannedMode('ordewell', modes, { readOnly: true }, true)).toEqual({ ok: true, mode: 'read-only' });
    expect(plannedMode('ordewell', modes, { readOnly: true }, false)).toEqual({ ok: true, mode: 'read-only' });
  });

  it('starts each planned mode as itself: no mode is unavailable, and read-only reaches the runner as a read-only task', () => {
    expect(['full', 'guarded', 'read-only'].map((mode) => attempt(mode))).toEqual(['full', 'guarded', 'read-only']);
    expect(resolveTaskRunnerFlags(ORDEWELL_MANIFEST, { mode: 'read-only' }).readOnly).toBe(true);
    expect(resolveTaskRunnerFlags(ORDEWELL_MANIFEST, { mode: 'guarded' }).readOnly).toBeUndefined();
  });
});
