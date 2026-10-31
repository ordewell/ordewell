import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { bodyRows, footerHints } from '../layout';
import { diffRoom } from '../handoff';
import { style } from '../ansi';
import type { HandoffView, TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const frame = (state: TuiState): string => render(state).join('\n');

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'completed', dependencies: [], ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 30, cols: 90, focus: 'plan', tasks, ...over });

const active = { state: 'active' as const, branch: 'ordewell/r1/1-t1', worktree: '/ws/.ordewell/worktrees/r1/1-t1', repos: [] };
const integrated = { state: 'integrated' as const, branch: 'ordewell/r1/1-t1', worktree: '/ws/.ordewell/worktrees/r1/1-t1', repos: [] };
const conflict = { state: 'conflict' as const, branch: 'ordewell/r1/2-t2', worktree: '/ws/.ordewell/worktrees/r1/2-t2', repos: [] };

describe('plan pane — isolation', () => {
  it('marks a conflicted task', () => {
    expect(frame(plan([task({ id: 't2', order: 2, status: 'awaiting_user', isolation: conflict })]))).toContain('⚠ merge conflict');
  });

  it('reads a repair waiting for a slot as that, and not as a conflict', () => {
    const out = frame(plan([task({ id: 't2', order: 2, status: 'pending', isolation: { ...conflict, conflictFiles: ['a.ts'], repairWaits: 'slot' } })], { cols: 160 }));

    expect(out).toContain('repair waits for a free slot (a.ts)');
    expect(out).not.toContain('merge conflict');
  });

  it('names the task resolving a conflict', () => {
    const out = frame(plan([task({ id: 't2', order: 2, status: 'awaiting_user', isolation: { ...conflict, resolver: 't1' } }), task({ id: 't1', order: 1 })], { cols: 160 }));

    expect(out).toContain('⚠ merge conflict: task #1 is resolving it');
  });

  it.each([
    ['none', { state: 'none' as const }],
    ['active', active],
    ['integrated', integrated],
    ['kept', { ...active, state: 'kept' as const }],
  ])('is quiet about a %s task', (_name, isolation) => {
    const out = frame(plan([task({ isolation })]));

    expect(out).not.toContain('conflict');
    expect(out).not.toContain('ordewell/r1');
    expect(out).not.toContain('⚠');
  });

  it('is quiet about a plan that never isolated', () => {
    expect(frame(plan([task()]))).not.toContain('⚠');
  });

  it('shows the branch and worktree in an expanded task\'s detail', () => {
    const out = frame(plan([task({ status: 'in_progress', isolation: active })], { expandedTaskId: 't1' }));

    expect(out).toContain('ordewell/r1/1-t1');
    expect(out).toContain('.ordewell/worktrees/r1/1-t1');
  });

  it('shows no worktree for a task that has landed, since it is gone', () => {
    const out = frame(plan([task({ isolation: integrated })], { expandedTaskId: 't1' }));

    expect(out).toContain('ordewell/r1/1-t1');
    expect(out).not.toContain('.ordewell/worktrees');
  });

  it('names the repositories a task changed beside its branch, and only for a group', () => {
    const group = frame(plan([task({ isolation: { ...integrated, repos: ['api', 'web'] } })], { expandedTaskId: 't1' }));
    const lone = frame(plan([task({ isolation: { ...integrated, repos: ['.'] } })], { expandedTaskId: 't1' }));

    expect(group).toContain('Repos');
    expect(group).toContain('api, web');
    expect(lone).not.toContain('Repos');
    expect(frame(plan([task({ isolation: { ...integrated, repos: [] } })], { expandedTaskId: 't1' }))).not.toContain('Repos');
  });

  it('names the repository a conflict stopped in, and keeps the plain mark for a group of one', () => {
    const named = frame(plan([task({ status: 'awaiting_user', isolation: { ...conflict, repos: ['api', 'web'], conflictRepo: 'web' } })]));
    const lone = frame(plan([task({ status: 'awaiting_user', isolation: { ...conflict, repos: ['.'], conflictRepo: '.' } })]));

    expect(named).toContain('⚠ merge conflict in web: ');
    expect(lone).toContain('⚠ merge conflict: ');
  });

  it('offers the resolve key only on a conflicted task', () => {
    expect(footerHints(plan([task({ isolation: conflict })]))).toContain('x resolve conflict');
    expect(footerHints(plan([task({ isolation: active })]))).not.toContain('x resolve conflict');
  });

  const repairing = { state: 'repairing' as const, branch: 'ordewell/r1/2-t2', worktree: '/ws/.ordewell/worktrees/r1/2-t2', repos: [], conflictFiles: ['a.ts'], repair: { attempt: 1, limit: 2 } };

  it('shows a repairing task as running, naming the files and the repair attempt (ADR-0015)', () => {
    const out = frame(plan([task({ id: 't2', order: 2, status: 'in_progress', isolation: repairing })], { cols: 200 }));

    expect(out).toContain('repairing conflict in a.ts (attempt 1/2)');
  });

  it('leaves off the attempt when it is not known yet, but still names the files', () => {
    const withoutAttempt = { state: 'repairing' as const, branch: repairing.branch, worktree: repairing.worktree, repos: repairing.repos, conflictFiles: repairing.conflictFiles };
    const out = frame(plan([task({ id: 't2', order: 2, status: 'in_progress', isolation: withoutAttempt })], { cols: 200 }));

    expect(out).toContain('repairing conflict in a.ts');
    expect(out).not.toContain('attempt');
  });

  it('offers no resolve key on a repairing task: a repair is already running', () => {
    expect(footerHints(plan([task({ isolation: repairing })]))).not.toContain('x resolve conflict');
  });

  it('marks a landed task that only landed after repairing a conflict', () => {
    const landedRepaired = { ...integrated, repairedFiles: ['a.ts', 'b.ts'] };
    const out = frame(plan([task({ isolation: landedRepaired })], { cols: 200 }));

    expect(out).toContain('landed after repairing conflict in a.ts, b.ts');
  });

  it('says nothing about a repair for a landed task that never needed one', () => {
    expect(frame(plan([task({ isolation: integrated })]))).not.toContain('repair');
  });
});

describe('handoff overlay frame over a repo group', () => {
  const t = (order: number, title: string) => ({ taskId: `t${order}`, order, title });
  const branch = 'ordewell/r1/integration';
  const handoff: HandoffView = {
    repos: [
      { path: 'api', integrationBranch: branch, baseRef: 'aaaaaaaaaaaaaaaa', baseBranch: 'main', landed: [t(1, 'One'), t(2, 'Two'), t(3, 'Three')] },
      { path: 'infra', integrationBranch: branch, baseRef: 'bbbbbbbbbbbbbbbb', startedDetached: true, landed: [] },
    ],
    landed: [t(1, 'One'), t(2, 'Two'), t(3, 'Three')],
  };
  const open = (over: Partial<TuiState> = {}): TuiState =>
    initialState({ sessionId: 's1', rows: 34, cols: 100, handoff, overlay: { kind: 'handoff', index: 0, diff: null }, ...over });

  it('says per repo what landed, or that there is nothing to merge', () => {
    const out = frame(open());

    expect(out).toContain('api: 3 tasks landed');
    expect(out).toContain('infra: nothing to merge');
  });

  it('offers Merge all for what Merge is called for one repo', () => {
    const out = frame(open());

    expect(out).toContain('Merge all');
    expect(out).toContain('every repository');
  });

  it('names where each repository forked from', () => {
    const out = frame(open());

    expect(out).toContain('api: main @ aaaaaaaaaaaa');
    expect(out).toContain('infra: detached at bbbbbbbbbbbb');
  });

  it('scrolls a long diff of many repos as before', () => {
    const lines = Array.from({ length: 100 }, (_, i) => (i === 0 ? '# api' : `+added ${i}`));
    const rows = render(open({ overlay: { kind: 'handoff', index: 0, diff: { lines, scroll: 10 } } }));

    expect(rows).toHaveLength(34);
    expect(rows.join('\n')).toContain('+added 10');
  });
});

describe('handoff overlay frame', () => {
  const handoff: HandoffView = {
    repos: [{
      path: '.',
      integrationBranch: 'ordewell/r1/integration',
      baseRef: 'abcdef1234567890',
      baseBranch: 'main',
      landed: [{ taskId: 't1', order: 1, title: 'Add the route' }, { taskId: 't2', order: 2, title: 'Write the tests' }],
    }],
    landed: [{ taskId: 't1', order: 1, title: 'Add the route' }, { taskId: 't2', order: 2, title: 'Write the tests' }],
  };
  const open = (over: Partial<TuiState> = {}): TuiState =>
    initialState({ sessionId: 's1', rows: 30, cols: 90, handoff, overlay: { kind: 'handoff', index: 0, diff: null }, ...over });

  it('names the branch, what landed in order, and the four actions', () => {
    const out = frame(open());

    expect(out).toContain('ordewell/r1/integration');
    expect(out.indexOf('#1 Add the route')).toBeLessThan(out.indexOf('#2 Write the tests'));
    for (const label of ['Review diff', 'Merge', 'Discard', 'Clean up']) expect(out).toContain(label);
  });

  it('reads as it always has for a group of one', () => {
    const out = frame(open());

    expect(out).not.toContain('nothing to merge');
    expect(out).not.toContain('Merge all');
    expect(out).toContain('Forked from main @ abcdef123456');
  });

  it('says plainly when nothing landed', () => {
    expect(frame(open({ handoff: { ...handoff, landed: [] } }))).toContain('Nothing landed on it.');
  });

  it('marks a landed task that only landed after a conflict repair, with its files (ADR-0015)', () => {
    const repaired = { ...handoff, landed: [{ ...handoff.landed[0], repairedFiles: ['a.ts', 'b.ts'] }, handoff.landed[1]] };
    const out = frame(open({ handoff: repaired }));

    expect(out).toContain('#1 Add the route');
    expect(out).toContain('repaired (a.ts, b.ts)');
    expect(out.indexOf('#2 Write the tests')).toBeGreaterThan(-1);
    expect(out.split('\n').find((l) => l.includes('#2 Write the tests'))).not.toContain('repaired');
  });

  it('marks the highlighted action', () => {
    const line = render(open({ overlay: { kind: 'handoff', index: 1, diff: null } })).find((l) => l.includes('Merge'));

    expect(line).toContain('❯');
  });

  it('paints a diff and fits it to the frame', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `+added ${i}`);
    const rows = render(open({ overlay: { kind: 'handoff', index: 0, diff: { lines, scroll: 10 } } }));

    expect(rows).toHaveLength(30);
    expect(rows.join('\n')).toContain('+added 10');
    expect(rows.join('\n')).not.toContain('+added 9\n');
  });

  it('keeps the end of a diff with long lines reachable, one row per line', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `+line ${i} ${'x'.repeat(300)}`);
    const room = diffRoom(bodyRows(open()));
    const rows = render(open({ overlay: { kind: 'handoff', index: 0, diff: { lines, scroll: lines.length - room } } }));
    const out = rows.join('\n');

    expect(rows).toHaveLength(30);
    expect(out).toContain('+line 59 ');
    expect(out).toContain('enter or esc goes back');
  });

  it('keeps a diff\'s tab indentation', () => {
    const { state } = reduce(open(), { type: 'handoffDiff', diff: '+func main() {\n+\treturn\n+}', sessionId: 's1' });

    expect(frame(state)).toMatch(/\+ {2,}return/);
  });

  it('asks before merging, in words that say it is the user\'s step', () => {
    const out = frame(open({
      overlay: { kind: 'confirm', title: 'Merge into your branch?', message: 'Merge ordewell/r1/integration into whatever you have checked out.', action: { kind: 'merge-run' } },
    }));

    expect(out).toContain('Merge into your branch?');
    expect(out).toContain('enter confirms · esc cancels');
  });

  it('renders the blocked-run question with the reason and all three choices', () => {
    const out = frame(initialState({
      sessionId: 's1', rows: 30, cols: 90,
      overlay: {
        kind: 'picker',
        picker: {
          title: 'Run blocked by uncommitted changes', hint: 'Tracked files have uncommitted changes',
          items: [{ id: 'stash', label: 'Stash and continue' }, { id: 'shared', label: 'Run without isolation' }, { id: 'cancel', label: 'Cancel' }],
          filter: '', index: 0, multi: false, chosen: [], filterable: false, action: { kind: 'isolation-blocked' },
        },
      },
    }));

    expect(out).toContain('Tracked files have uncommitted changes');
    for (const label of ['Stash and continue', 'Run without isolation', 'Cancel']) expect(out).toContain(label);
  });
});
