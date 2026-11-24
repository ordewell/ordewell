import { describe, expect, it } from 'vitest';
import { runHeldDetail, standingDetail, untoldDetail, type RunHold } from '../runHolds';
import { configHoldReason, isConfigHold } from '../taskStartConfig';

/**
 * A start held for repository configuration is released only by the user's
 * own start (ADR-0028): what a woken supervisor reads of one says so, and
 * names none of its own calls as a release, which would start the task in the
 * same run and be held again.
 */

const reason = configHoldReason(['.claude/settings.json']);
const describeTask = (id: string) => `#1 "Task ${id}"`;
const RELEASE = 'Only the user can release a hold for repository configuration: a retry_task or run_task of yours starts it in this run, where it is held again. Tell the user what it is held for.';

describe('a start held for repository configuration, as the supervisor is told of it', () => {
  it('says what releases it, which only the user can do', () => {
    expect(reason).toBe('repository configuration ".claude/settings.json" differs from where this run started; remove it to continue, or merge the run into your branch, stop it and start this task yourself: only your own start begins a new run from your branch, and only once that holds all this run landed and no other task\'s work is left in it');
    expect(isConfigHold(reason)).toBe(true);
    expect(isConfigHold('cancelled; retry or force start to run it again')).toBe(false);
    expect(isConfigHold(undefined)).toBe(false);
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
