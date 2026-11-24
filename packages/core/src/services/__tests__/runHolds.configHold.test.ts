import { describe, expect, it } from 'vitest';
import { runHeldDetail, standingDetail, untoldDetail, type RunHold } from '../runHolds';
import { configHoldReason, isChildPlanConfigHold, isConfigHold } from '../taskStartConfig';

/**
 * A start held for repository configuration is released only by a person's
 * own start, and per run (ADR-0028): what a woken supervisor reads of one says
 * so, and names none of its own calls as a release, which would start the task
 * in the run it was held in and be held again. In a child plan nothing
 * releases it, and the lines say what can be done there instead.
 */

const reason = configHoldReason(['.claude/settings.json']);
const inChild = configHoldReason(['.claude/settings.json'], true);
const describeTask = (id: string) => `#1 "Task ${id}"`;
const RELEASE = 'Only the user can release a hold for repository configuration: once their branch holds everything this run landed, their own start of a task in a worktree begins a new run from it, where no task is held for it. Until then a retry_task or run_task of yours starts it in the run it was held in, where it is held again. Tell the user what it is held for.';
const CHILD_RELEASE = 'Nothing in a child plan releases a hold for repository configuration: a retry_task or run_task of yours starts it in this run, where it is held again. If its work allows, make it read-only with edit_plan, which loads no project configuration, and start it with run_task; otherwise take it out with edit_plan and say why in your report.';

describe('a start held for repository configuration, as the supervisor is told of it', () => {
  it('says what releases it, which only a person can do, for the whole run it opens', () => {
    expect(reason).toBe('repository configuration ".claude/settings.json" differs from where this run started; remove it to continue, or merge everything this run landed into your branch, stop the run and start this task yourself: only your own start of a task that works in a worktree begins a new run from your branch, once that holds all this run landed and no other task\'s work is left in it, and no task of that new run is held for this configuration');
    expect(isConfigHold(reason)).toBe(true);
    expect(isChildPlanConfigHold(reason)).toBe(false);
    expect(isConfigHold('cancelled; retry or force start to run it again')).toBe(false);
    expect(isConfigHold(undefined)).toBe(false);
  });

  it('says, in a child plan, that nothing gets past it there and what its subplanner can do, which a person can ask for', () => {
    expect(inChild).toBe('repository configuration ".claude/settings.json" differs from where this run started, and no start in a child plan gets past that: only its subplanner starts tasks here, and each of its starts continues this run. The subplanner can make this task read-only, which loads no project configuration, and start it, or take it out of the plan and say why in its report; a person can ask it to with a message');
    expect(isConfigHold(inChild)).toBe(true);
    expect(isChildPlanConfigHold(inChild)).toBe(true);
    expect(isChildPlanConfigHold(undefined)).toBe(false);
  });

  it.each([
    ['standing after its turn', () => standingDetail({ taskId: 't1', block: { kind: 'on-hold', reason: inChild }, holdsBack: 1 }, describeTask)],
    ['never told', () => untoldDetail({ taskId: 't1', block: { kind: 'on-hold', reason: inChild }, holdsBack: 1 }, describeTask, '')],
    ['the run idle behind it', () => runHeldDetail([{ taskId: 't1', hold: { kind: 'on-hold', reason: inChild }, holdsBack: 1 }], describeTask, () => 'Ordewell')],
  ])('tells a subplanner what it can do of its own when %s, and sends it to no user', (_when, line) => {
    const said = line();
    expect(said).toContain(CHILD_RELEASE);
    expect(said).not.toContain(RELEASE);
    expect(said).not.toContain('Tell the user');
  });

  it.each([
    ['standing after its turn', () => standingDetail({ taskId: 't1', block: { kind: 'on-hold', reason }, holdsBack: 1 }, describeTask)],
    ['never told', () => untoldDetail({ taskId: 't1', block: { kind: 'on-hold', reason }, holdsBack: 1 }, describeTask, '')],
  ])('names no call of its own as the release when %s', (_when, line) => {
    const said = line();
    expect(said).toContain(RELEASE);
    expect(said).not.toContain('Release it:');
    expect(said).not.toContain('call retry_task from "fresh"');
  });

  it('keeps the calls that do release another hold', () => {
    const said = standingDetail({ taskId: 't1', block: { kind: 'on-hold', reason: 'cancelled; retry or force start to run it again' }, holdsBack: 1 }, describeTask);
    expect(said).toContain('Release it: call retry_task from "fresh"');
    expect(said).not.toContain(RELEASE);
  });

  it('says, of a run idle behind it, that only the user can release it, beside what releases another hold', () => {
    const config: RunHold = { taskId: 't1', hold: { kind: 'on-hold', reason }, holdsBack: 1 };
    const cancelled: RunHold = { taskId: 't2', hold: { kind: 'on-hold', reason: 'cancelled; retry or force start to run it again' }, holdsBack: 0 };

    const alone = runHeldDetail([config], describeTask, () => 'Ordewell');
    expect(alone.endsWith(` ${RELEASE}`)).toBe(true);
    expect(alone).not.toContain('starts again only once it is retried or force started');

    const both = runHeldDetail([config, cancelled], describeTask, () => 'Ordewell');
    expect(both).toContain('A task on hold starts again only once it is retried or force started; the user can also skip it, which releases what needs it.');
    expect(both.endsWith(` ${RELEASE}`)).toBe(true);
  });
});
