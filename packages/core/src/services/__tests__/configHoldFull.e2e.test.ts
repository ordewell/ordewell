import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cleanUp, hasGit, heldPlan, HOOK, ok, USER, type HeldTask } from './heldConfigKit';

/**
 * What the user is told of configuration a run changes (ADR-0028), on real
 * git: in Full, a start the check would have held goes ahead in its runner's
 * Full mode and says so once per path in the run; a landing that changes
 * configuration says so in either level, with no later start needed; and a
 * write into the checkout, which no landing carries, is said as the next
 * task ends, whoever wrote it, and again by the next start in Full that
 * reads it.
 */

afterEach(cleanUp);

const WAIT = { timeout: 20_000 };
const FULL = { autonomous: true, mode: 'bypassPermissions' } as const;
const GUARDED = { autonomous: false, mode: 'auto' } as const;

/** What the starts that went ahead said, by line. */
const unheld = (told: string[]) => told.filter((line) => / starts with repository configuration /.test(line));
const ended = (told: string[]) => told.filter((line) => line.startsWith('As task "'));

describe.skipIf(!hasGit)('a run that changes configuration, in Full and in Guarded', () => {
  /** t1 lands the hook; t2 and t3 start after it, t2 landing `.mcp.json` too; t4 starts after both. */
  const plan: HeldTask[] = [
    { id: 't1', title: 'Add a hook', hook: true },
    { id: 't2', title: 'Wire the server', dependencies: ['t1'], writes: '.mcp.json' },
    { id: 't3', title: 'Read the hook', dependencies: ['t1'] },
    { id: 't4', title: 'Use both', dependencies: ['t2', 't3'] },
  ];

  it('in Full, starts every task in its Full mode and says each path once in the run, as the first start that loads it', async () => {
    const held = heldPlan(plan, FULL);
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(['t1', 't2', 't3', 't4'].map(held.statusOf)).toEqual(['completed', 'completed', 'completed', 'completed']), WAIT);

    expect(['t1', 't2', 't3', 't4'].map(held.holdOf)).toEqual([null, null, null, null]);
    expect(held.hookFor('t4')).toEqual([true]);
    const said = unheld(held.told());
    // t2 and t3 both load the hook, and only the first to start says so; t4 loads it and t2's server, and says the server alone.
    expect(said).toHaveLength(2);
    expect(said[0]).toMatch(/^Task "(Wire the server|Read the hook)" starts with repository configuration "\.claude\/settings\.json", which differs from where this run started\. /);
    expect(said[0]).toContain('later tasks in Full load it without a hold too');
    expect(said[1]).toMatch(/^Task "Use both" starts with repository configuration "\.mcp\.json", which differs/);
    expect(ended(held.told())).toEqual([]);
  });

  it('in Guarded, holds the same starts and says none of them went ahead', async () => {
    const held = heldPlan(plan, GUARDED);
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect([held.holdOf('t2'), held.holdOf('t3')]).toEqual([expect.stringContaining(HOOK), expect.stringContaining(HOOK)]), WAIT);

    expect(held.spawned).toEqual(['t1']);
    expect(held.holds('t2')).toBe(1);
    expect(held.holds('t3')).toBe(1);
    expect(unheld(held.told())).toEqual([]);
  });

  it.each([['Guarded', GUARDED], ['Full', FULL]] as const)('in %s, a landing that adds configuration says so, though no task starts after it', async (_level, level) => {
    const held = heldPlan([{ id: 't1', title: 'Add a hook', hook: true }], level);
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.statusOf('t1')).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(held.told()).toContain('Task "Add a hook" landed a change to repository configuration ".claude/settings.json", which a runner loads as it starts.'), WAIT);
    expect(held.told().filter((line) => line.includes(' landed a change to repository configuration '))).toHaveLength(1);
  });

  it.each([['Guarded', GUARDED], ['Full', FULL]] as const)('in %s, a landing that changes configuration the base holds says so', async (_level, level) => {
    const held = heldPlan([{ id: 't1', title: 'Change the hook', hook: true }], { ...level, files: [HOOK] });
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.statusOf('t1')).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(held.told()).toContain('Task "Change the hook" landed a change to repository configuration ".claude/settings.json", which a runner loads as it starts.'), WAIT);
  });

  it.each([['Guarded', GUARDED], ['Full', FULL]] as const)('in %s, a landing that removes configuration says so', async (_level, level) => {
    const held = heldPlan([{ id: 't1', title: 'Drop the server', removes: '.mcp.json' }], { ...level, files: ['.mcp.json'] });
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.statusOf('t1')).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(held.told()).toContain('Task "Drop the server" landed a change to repository configuration ".mcp.json", which a runner loads as it starts.'), WAIT);
    expect(held.fileOn('ordewell/run1/integration', '.mcp.json')).toBeNull();
  });

  it('a landing of anything else says nothing of configuration', async () => {
    const held = heldPlan([{ id: 't1', title: 'Write a note' }], FULL);
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.statusOf('t1')).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(held.told().some((line) => line.startsWith('Task "Write a note"'))).toBe(true), WAIT);
    expect(held.told().filter((line) => line.includes('repository configuration'))).toEqual([]);
  });

  /** t1, an ops task, writes `.mcp.json` into the checkout, which no landing carries; t2, an ops task after it, loads it. */
  const inCheckout: HeldTask[] = [
    { id: 't1', title: 'Write the server', ops: true, writes: '.mcp.json' },
    { id: 't2', title: 'Use the server', ops: true, dependencies: ['t1'] },
  ];

  it('in Full, says a write into the checkout as its task ends, and again as the next start that loads it goes ahead', async () => {
    const held = heldPlan(inCheckout, FULL);
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect([held.statusOf('t1'), held.statusOf('t2')]).toEqual(['completed', 'completed']), WAIT);

    expect(held.inCheckout('.mcp.json')).toBe('{}\n');
    expect(ended(held.told())).toEqual(['As task "Write the server" ends, repository configuration ".mcp.json" in your checkout differs from where this run started; this task, another task, a script or you may have written it. A later task that starts there, or reads it through a worktree\'s link, can load it.']);
    expect(unheld(held.told())).toEqual([expect.stringMatching(/^Task "Use the server" starts with repository configuration "\.mcp\.json", which differs/)]);
    expect(held.holdOf('t2')).toBeNull();
  });

  it('in Guarded, says the write as its task ends, and holds the next start that loads it', async () => {
    const held = heldPlan(inCheckout, GUARDED);
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect(held.holdOf('t2')).toContain('".mcp.json"'), WAIT);

    expect(ended(held.told())).toEqual([expect.stringMatching(/^As task "Write the server" ends, repository configuration "\.mcp\.json" in your checkout/)]);
    expect(unheld(held.told())).toEqual([]);
    expect(held.spawns('t2')).toBe(0);
  });

  it('in Guarded, says a write through a worktree\'s link as the first task ends, naming no writer, and once', async () => {
    const held = heldPlan([
      { id: 't1', title: 'Write the hook' },
      { id: 't2', title: 'Write a note' },
    ], { ...GUARDED, hold: ['t1', 't2'] });
    // An ignored `.claude` in the checkout, which each worktree links.
    mkdirSync(join(held.root, '.claude'));
    appendFileSync(join(held.root, '.git', 'info', 'exclude'), '.claude/\n');
    await ok(held.session, { command: 'run_plan' }, USER);
    await vi.waitFor(() => expect([...held.spawned].sort()).toEqual(['t1', 't2']), WAIT);

    // t1 writes the hook through its link and keeps running; t2, which wrote no configuration, ends first.
    writeFileSync(join(held.lastCwd('t1'), HOOK), '{}\n');
    expect(existsSync(join(held.root, HOOK))).toBe(true);
    held.release('t2');
    await vi.waitFor(() => expect(held.statusOf('t2')).toBe('completed'), WAIT);
    held.release('t1');
    await vi.waitFor(() => expect(held.statusOf('t1')).toBe('completed'), WAIT);

    expect(ended(held.told())).toEqual([`As task "Write a note" ends, repository configuration "${HOOK}" in your checkout differs from where this run started; this task, another task, a script or you may have written it. A later task that starts there, or reads it through a worktree's link, can load it.`]);
  });
});
