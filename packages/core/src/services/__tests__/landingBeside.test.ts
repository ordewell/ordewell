import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { composeAugmentedPrompt, landsBeside, renderLandingBeside, type LandingBeside } from '../promptAugment';
import { attemptPrompt, type AttemptPromptSources } from '../attemptKind';
import { landingMessage } from '../landingMessage';

const t = (id: string, extra: Partial<Task> = {}): Task => ({ ...createTask({ id, order: Number(id.replace(/\D/g, '')) || 1, title: `Task ${id}`, prompt: `Do ${id}.` }), ...extra });

/** A sibling's work lands unless it is read-only or ops, as the attempt's own reading would say here. */
const lands = (sibling: Task): boolean => !sibling.readOnly && !sibling.ops;

const lone: LandingBeside = { integrationBranch: 'ordewell/r1/integration', message: "Merge: Fill in the parser (take in landed work)", repos: ['.'] };

describe('what a change task is told of the work landing beside it (ADR-0013)', () => {
  it('names the integration branch, the merge that takes it in, and that a stand-in is never the way', () => {
    expect(renderLandingBeside(lone)).toBe([
      '## Work landing beside yours',
      '',
      'Other tasks of this plan run beside this one, each in its own worktree, and each lands its work on `ordewell/r1/integration` when it passes. Your worktree was cut from that branch when this task started: it holds what had landed by then, and nothing since. `git log --oneline HEAD..ordewell/r1/integration` lists what has landed after.',
      "When code you build or test calls code another task owns, and it is missing or still a stub here, look there first. If that work has landed, commit your work and take it in with `git merge --no-edit -m 'Merge: Fill in the parser (take in landed work)' ordewell/r1/integration`; resolve any conflict so that both sides' intent survives. If you cannot, `git merge --abort` puts your worktree back as it was: go on without that work, and never reset your own work away. Take in what has landed once more before you finish, so that what you report was checked against it.",
      "Never write a stand-in for another task's code, fill it in yourself, or build a scratch copy of the project with it filled in: none of that lands, and what you check against it says nothing of the code that will. If the work you need has not landed, never sleep or poll for it: call `wait_for` with the tasks whose work it is, and this attempt ends, its slot goes to other work, and Ordewell continues this session once that work lands. Where wait_for refuses, finish your own part, and once the checks left fail only because that work is missing, stop working on them. Name each such check, and the task whose work it needs, in a finding, and end as your brief's done criterion says.",
    ].join('\n'));
  });

  it('in a repo group, merges in every repository of the run, each in its own directory', () => {
    const text = renderLandingBeside({ ...lone, repos: ['api', 'web'] });
    expect(text).toContain("commit your work and, in each repository of the run (api, web), run `git merge --no-edit -m 'Merge: Fill in the parser (take in landed work)' ordewell/r1/integration` inside that repository's directory;");
  });

  it('quotes the message for a shell, the trailer as its own -m, as a repair is told', () => {
    const message = landingMessage('take-in', { title: "Fix the user's greeting" }, true);
    expect(message).toBe("Merge: Fix the user's greeting (take in landed work)\n\nPlanned-with: Ordewell");
    expect(renderLandingBeside({ ...lone, message })).toContain(`git merge --no-edit -m 'Merge: Fix the user'\\''s greeting (take in landed work)' -m 'Planned-with: Ordewell' ordewell/r1/integration`);
  });

  it('rides in the first message, after the prior outputs and before the brief, only when asked for', () => {
    const task = t('t2');
    const told = composeAugmentedPrompt(task, [t('t1'), task], { beside: lone });
    expect(told).toContain('## Work landing beside yours');
    expect(told.endsWith('Do t2.')).toBe(true);
    expect(composeAugmentedPrompt(task, [t('t1'), task])).not.toContain('Work landing beside yours');
  });

  it('is given to a change and a carry-over, never to a read-only task or a repair', () => {
    const task = t('t2');
    const src: AttemptPromptSources = {
      task, plan: [t('t1'), task], skills: [], beside: lone,
      repairPrompt: () => 'Repair it.', previousAttempt: () => undefined, previousHandoff: () => undefined,
    };
    expect(attemptPrompt({ kind: 'change' } as never, src)).toContain('## Work landing beside yours');
    expect(attemptPrompt({ kind: 'carryOver', from: 'codex' } as never, src)).toContain('## Work landing beside yours');
    expect(attemptPrompt({ kind: 'readOnly' } as never, src)).not.toContain('Work landing beside yours');
    expect(attemptPrompt({ kind: 'repair' } as never, src)).not.toContain('Work landing beside yours');
  });
});

describe('landsBeside: whether anything of the plan may land while a task runs', () => {
  it('holds for a sibling change not yet finished, whatever its status before completion', () => {
    for (const status of ['pending', 'in_progress', 'failed', 'awaiting_user'] as const) {
      expect(landsBeside(t('t1'), [t('t1'), t('t2', { status })], lands)).toBe(true);
    }
  });

  it('does not hold for siblings that landed or were skipped, nor for tasks that wait for it', () => {
    const a = t('t1');
    expect(landsBeside(a, [a, t('t2', { status: 'completed' }), t('t3', { status: 'skipped' })], lands)).toBe(false);
    // t3 waits for t1 through t2: none of them can land while t1 runs.
    expect(landsBeside(a, [a, t('t2', { dependencies: ['t1'] }), t('t3', { dependencies: ['t2'] })], lands)).toBe(false);
  });

  it('counts only a sibling whose work lands, as the caller judges it', () => {
    const a = t('t1');
    expect(landsBeside(a, [a, t('t2', { readOnly: true }), t('t3', { ops: true })], lands)).toBe(false);
    expect(landsBeside(a, [a, t('t2', { type: 'delegated', prompt: undefined, goal: 'Do it.' })], lands)).toBe(true);
    // The caller's reading is the one that holds: the flag alone decides nothing.
    expect(landsBeside(a, [a, t('t2', { readOnly: true })], () => true)).toBe(true);
  });

  // A subtask waits for its ancestors' dependencies, not for its ancestors (ADR-0034): the two start together.
  it('counts its parent and its own subtasks, which run beside it, at every depth', () => {
    const grandchild = t('t111');
    const sub = t('t11', { subtasks: [grandchild] });
    const parent = t('t1', { subtasks: [sub] });
    for (const at of [parent, sub, grandchild]) expect(landsBeside(at, [parent], lands)).toBe(true);
    expect(landsBeside(t('t1', { subtasks: [t('t11', { status: 'completed' })] }), [t('t1', { subtasks: [t('t11', { status: 'completed' })] })], lands)).toBe(false);
    const other = t('t2', { subtasks: [t('t21')], status: 'completed' });
    expect(landsBeside(other.subtasks[0], [t('t1', { status: 'completed' }), other], lands)).toBe(false);
    expect(landsBeside(t('t3'), [t('t3'), other], lands)).toBe(true);
  });

  it('does not count a subtask of a task that waits for it, at any depth', () => {
    const a = t('t1');
    expect(landsBeside(a, [a, t('t2', { dependencies: ['t1'], subtasks: [t('t21', { subtasks: [t('t211')] })] })], lands)).toBe(false);
  });

});
