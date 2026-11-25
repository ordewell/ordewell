import { describe, expect, it } from 'vitest';
import { runHeldDetail, standingDetail, untoldDetail, type RunHold } from '../runHolds';
import { configHoldReason, isCheckoutConfigHold, isChildPlanConfigHold, isConfigHold } from '../taskStartConfig';

/**
 * A start held for repository configuration in a worktree's tree is released
 * by a person's own start of a task in a worktree, which begins a new run,
 * and per run (ADR-0028): what a woken supervisor reads of one says so, and
 * names none of its own calls as a release, which would start the task in the
 * run it was held in and be held again. One held for configuration in the
 * checkout, or linked from it, says what it always said, and the supervisor
 * is told to leave it to the user (the review of 8edf6409, F1). In a child
 * plan the lines say what its subplanner can do there.
 */

const HOOK = '.claude/settings.json';
const reason = configHoldReason({ base: [HOOK], live: [] });
const inChild = configHoldReason({ base: [HOOK], live: [] }, true);
const inCheckout = configHoldReason({ base: [], live: [HOOK] });
const inChildCheckout = configHoldReason({ base: [], live: [HOOK] }, true);
const describeTask = (id: string) => `#1 "Task ${id}"`;
const RELEASE = 'Leave this hold to the user: once their branch holds everything this run landed, merged and not squashed or rebased, and nothing of this run is left (no task running, no work that never landed, the held task\'s own included, no kept attempt and no delegated task\'s child plan), their own start of a task that works in a worktree begins a new run from their branch, whose base holds the configuration. A retry_task or run_task of yours starts it in this run, where it is held again. Tell the user what it is held for.';
const CHECKOUT_RELEASE = 'Leave this hold to the user, who can remove the configuration or start a new run once their branch holds it. Tell the user what it is held for.';
const CHILD_RELEASE = 'If its work allows, make it read-only with edit_plan, which loads no project configuration, and start it with run_task; otherwise take it out with edit_plan and say why in your report.';

describe('a start held for repository configuration, as the supervisor is told of it', () => {
  it('says, of configuration in the tree, what releases it: a person\'s start of a task in a worktree, which begins a run from their branch, once nothing of this run is left, the held task\'s own work included (the review of 8edf6409, F2)', () => {
    expect(reason).toBe('repository configuration ".claude/settings.json" differs from where this run started; remove it to continue, or merge everything this run landed into your branch, with Merge all or a merge of your own (a squash or a rebase does not count), stop the run and start this task yourself: your own start of a task that works in a worktree then begins a new run from your branch, whose base holds this configuration, provided nothing of this run is left: no task running, and no work that never landed, this task\'s own included, no kept attempt and no delegated task\'s child plan. Where this task holds such work of its own, a Continue keeps it, and the run with it, so it is held again there; a fresh start (Start now, Retry or Run) discards that work and is held once more, and your next start then begins the new run');
    expect(isConfigHold(reason)).toBe(true);
    expect(isChildPlanConfigHold(reason)).toBe(false);
    expect(isCheckoutConfigHold(reason)).toBe(false);
    expect(isConfigHold('cancelled; retry or force start to run it again')).toBe(false);
    expect(isConfigHold(undefined)).toBe(false);
  });

  it('says, of configuration in the checkout or linked from it, what it said before this change, the next run taking its own look (the review of 8edf6409, F1)', () => {
    expect(inCheckout).toBe('repository configuration ".claude/settings.json" differs from where this run started; remove it to continue, or start a new run once your branch holds it');
    expect(isCheckoutConfigHold(inCheckout)).toBe(true);
    expect(isChildPlanConfigHold(inCheckout)).toBe(false);
    // Found in the tree too, it is held as configuration in the tree, whose release the run's is.
    expect(configHoldReason({ base: [HOOK], live: ['.mcp.json'] })).toBe(reason.replace('".claude/settings.json"', '".claude/settings.json", ".mcp.json"'));
  });

  it('says, in a child plan, what its subplanner can do, which a person can ask for', () => {
    expect(inChild).toBe('repository configuration ".claude/settings.json" differs from where this run started. The subplanner can make this task read-only, which loads no project configuration, and start it, or take it out of the plan and say why in its report; a person can ask it to with a message');
    expect(inChildCheckout).toBe('repository configuration ".claude/settings.json" differs from where this run started; remove it to continue, or start a new run once your branch holds it. The subplanner can make this task read-only, which loads no project configuration, and start it, or take it out of the plan and say why in its report; a person can ask it to with a message');
    for (const held of [inChild, inChildCheckout]) {
      expect(isConfigHold(held)).toBe(true);
      expect(isChildPlanConfigHold(held)).toBe(true);
    }
    expect(isChildPlanConfigHold(undefined)).toBe(false);
  });

  it.each([inChild, inChildCheckout].flatMap((held) => [
    ['standing after its turn', () => standingDetail({ taskId: 't1', block: { kind: 'on-hold', reason: held }, holdsBack: 1 }, describeTask)],
    ['never told', () => untoldDetail({ taskId: 't1', block: { kind: 'on-hold', reason: held }, holdsBack: 1 }, describeTask, '')],
    ['the run idle behind it', () => runHeldDetail([{ taskId: 't1', hold: { kind: 'on-hold', reason: held }, holdsBack: 1 }], describeTask, () => 'Ordewell')],
  ] as const))('tells a subplanner what it can do of its own when %s, and sends it to no user', (_when, line) => {
    const said = line();
    expect(said).toContain(CHILD_RELEASE);
    expect(said).not.toContain(RELEASE);
    expect(said).not.toContain(CHECKOUT_RELEASE);
    expect(said).not.toContain('Tell the user');
  });

  it.each([
    ['standing after its turn', () => standingDetail({ taskId: 't1', block: { kind: 'on-hold', reason: inCheckout }, holdsBack: 1 }, describeTask)],
    ['never told', () => untoldDetail({ taskId: 't1', block: { kind: 'on-hold', reason: inCheckout }, holdsBack: 1 }, describeTask, '')],
    ['the run idle behind it', () => runHeldDetail([{ taskId: 't1', hold: { kind: 'on-hold', reason: inCheckout }, holdsBack: 1 }], describeTask, () => 'Ordewell')],
  ])('tells the supervisor to leave a hold for configuration in the checkout to the user when %s, claiming nothing of its own calls', (_when, line) => {
    const said = line();
    expect(said).toContain(CHECKOUT_RELEASE);
    expect(said).not.toContain(RELEASE);
    expect(said).not.toContain('held again');
    expect(said).not.toContain('Release it:');
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

  it('says, of a run idle behind it, to leave it to the user, beside what releases another hold', () => {
    const config: RunHold = { taskId: 't1', hold: { kind: 'on-hold', reason }, holdsBack: 1 };
    const cancelled: RunHold = { taskId: 't2', hold: { kind: 'on-hold', reason: 'cancelled; retry or force start to run it again' }, holdsBack: 0 };

    const alone = runHeldDetail([config], describeTask, () => 'Ordewell');
    expect(alone.endsWith(` ${RELEASE}`)).toBe(true);
    expect(alone).not.toContain('starts again once it is retried or force started');

    const both = runHeldDetail([config, cancelled], describeTask, () => 'Ordewell');
    expect(both).toContain('A task on hold starts again once it is retried or force started; the user can also skip it, which releases what needs it.');
    expect(both.endsWith(` ${RELEASE}`)).toBe(true);
  });
});
