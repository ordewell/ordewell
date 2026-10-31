import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import PlanCardGroup from '../PlanCardGroup';
import TaskCard from '../TaskCard';
import type { Task, RunTask, RunView } from '@ordewell/core';
import { EMPTY_RUN } from '@ordewell/core/plan-utils';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'c', order: 1, title: 'Review', description: 'Review the change', type: 'ai', status: 'pending',
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

const check = (over: Partial<Task> = {}): Task => makeTask({ loop: { body: ['f'], maxRounds: 3 }, ...over });
const fix = (over: Partial<Task> = {}): Task => makeTask({ id: 'f', order: 2, title: 'Fix', dependencies: ['c'], ...over });
const found = { outcome: 'fail' as const, reason: 'two problems', checks: [], reported: 'failed' as const };
const runOf = (...entries: Partial<RunTask>[]): RunView => ({ ...EMPTY_RUN, tasks: entries.map((e) => ({ subtasks: [], ...e }) as RunTask) });

const loopBadges = (): string[] => Array.from(document.querySelectorAll('.task-isolation-badge.loop')).map((b) => b.textContent ?? '');

describe('a loop on the plan cards (ADR-0045)', () => {
  it('badges the check with the rounds it may run, and its body with the check it runs for', () => {
    render(<PlanCardGroup run={EMPTY_RUN} tasks={[check(), fix()]} models={[]} />);

    expect(loopBadges()).toEqual(['Loop of up to 3 rounds', 'Runs if #1 fails']);
    expect(document.querySelector('.task-isolation-badge.loop.waiting')?.getAttribute('title')).toBe('Loop of up to 3 rounds. Runs #2 if it fails');
  });

  it('badges the check with its round while it runs', () => {
    render(<PlanCardGroup run={runOf({ id: 'c', loopRound: 2 })} tasks={[check({ status: 'in_progress' }), fix()]} models={[]} isExecuting />);

    expect(loopBadges()[0]).toBe('Loop · Round 2 of 3');
    expect(document.querySelector('.task-isolation-badge.loop.running')).toBeTruthy();
  });

  it('shows a check between rounds as fixing, from the run\'s verdict, and its body with the round it fixes', () => {
    const run = runOf({ id: 'c', verdict: found, loopRound: undefined }, { id: 'f' });
    render(<PlanCardGroup run={run} tasks={[check({ status: 'failed' }), fix({ status: 'in_progress' })]} models={[]} isExecuting />);

    expect(loopBadges()).toEqual(['Loop · Round 1 of 3: fixing', 'Runs if #1 fails (round 1 of 3)']);
    expect(document.querySelector('.task-isolation-badge.loop.repeating')?.getAttribute('title'))
      .toBe('Round 1 of 3: fixing. Found problems: runs again once #2 has landed');
    expect(document.querySelector('.status-failed')).toBeNull();
  });

  it('shows a check nothing will run as stopped and failed, told by the run', () => {
    const run = runOf({ id: 'c', verdict: found, loopRound: undefined, loopStranded: true }, { id: 'f' });
    render(<PlanCardGroup run={run} tasks={[check({ status: 'failed' }), fix()]} models={[]} />);

    expect(loopBadges()[0]).toBe('Loop · Stopped in round 1 of 3');
    expect(document.querySelector('.status-failed')).toBeTruthy();
  });

  it('shows the same check as failed once its loop is out of rounds', () => {
    const run = runOf({ id: 'c', verdict: found, loopRound: 3 }, { id: 'f' });
    render(<PlanCardGroup run={run} tasks={[check({ status: 'failed' }), fix({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' })]} models={[]} isExecuting />);

    expect(loopBadges()[0]).toBe('Loop · Failed after 3 rounds');
    expect(document.querySelector('.task-isolation-badge.loop.out-of-rounds')).toBeTruthy();
    expect(document.querySelector('.status-failed')).toBeTruthy();
  });

  it('says in which round the check passed', () => {
    const run = runOf({ id: 'c', verdict: { ...found, outcome: 'pass', reported: 'done' }, loopRound: 2 }, { id: 'f' });
    render(<PlanCardGroup run={run} tasks={[check({ status: 'completed' }), fix({ status: 'skipped' })]} models={[]} isExecuting />);

    expect(loopBadges()[0]).toBe('Loop · Passed in round 2 of 3');
  });

  it('draws no loop badge on a plan without one', () => {
    render(<PlanCardGroup run={EMPTY_RUN} tasks={[makeTask(), makeTask({ id: 'g', order: 2 })]} models={[]} />);

    expect(loopBadges()).toEqual([]);
  });

  it('keeps Remove on a body task and a check alike: core decides', () => {
    render(<PlanCardGroup run={EMPTY_RUN} tasks={[check(), fix()]} models={[]} onRemoveTask={() => {}} />);

    expect(document.querySelectorAll('.task-remove-btn')).toHaveLength(2);
  });
});

describe('a lone card', () => {
  it('reads its own verdict and round off the run it is given', () => {
    render(<TaskCard task={check({ status: 'failed' })} models={[]} isExecuting siblings={[check({ status: 'failed' }), fix({ status: 'in_progress' })]}
      run={{ verdict: found, loopRound: 2 } as unknown as RunTask} />);

    expect(loopBadges()).toEqual(['Loop · Round 2 of 3: fixing']);
  });
});
