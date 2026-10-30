import { describe, it, expect } from 'vitest';
import {
  taskRowView, taskStatusKind, isTaskRunning, awaitingLabel, approvalLabel, resumeLabel, resumeTime, taskRowActions, markAction, taskActionCommand, overrideNeedsConfirmation, confirmedOverride, manualOverrideConfirmation, manualOverrideStopFirst, opsEditable, revertEffect, revertListLine,
  titledRefs, dependentsNotice, pastGateConfirmation, newTaskFields, noExecutorRefusal, blockedByLabel, holdLabel, skippedLabel, type TaskRowSubject, type TaskRowAction,
} from '..';
import { taskRef, titledTaskRef } from '../../services/TaskRefs';

const STATUSES = ['pending', 'approved', 'blocked', 'in_progress', 'awaiting_user', 'completed', 'failed', 'skipped'] as const;

const subject = (over: Partial<TaskRowSubject> = {}): TaskRowSubject => ({
  id: 't2', order: 2, type: 'ai', status: 'pending', dependencies: [], ...over,
});
const tasks = [{ id: 't1', order: 1, title: 'One' }, { id: 't2', order: 2, title: 'Two' }];

describe('status kind', () => {
  it.each([
    ['pending', null, 'todo', false],
    ['approved', null, 'todo', false],
    ['blocked', null, 'blocked', false],
    ['in_progress', null, 'running', true],
    ['in_progress', '2026-01-01T00:00:00Z', 'quiet', true],
    ['running', null, 'running', true],
    ['running', '2026-01-01T00:00:00Z', 'running', true],
    ['awaiting_user', null, 'awaiting', false],
    ['completed', null, 'done', false],
    ['completed', '2026-01-01T00:00:00Z', 'done', false],
    ['failed', null, 'failed', false],
    ['skipped', null, 'skipped', false],
    ['something-new', null, 'todo', false],
  ])('%s, silent since %s, is %s', (status, idleSince, kind, running) => {
    expect(taskStatusKind({ status, idleSince })).toBe(kind);
    expect(isTaskRunning({ status })).toBe(running);
  });
});

describe('labels', () => {
  it.each([
    ['input', 'Waiting for your input'],
    ['checkpoint', 'Checkpoint'],
    ['conflict', 'Merge conflict'],
    ['files-changed', 'Changed tracked files'],
    ['usage-limit', 'Paused on a usage limit'],
  ] as const)('an awaiting task waiting on %s reads "%s"', (awaitingReason, label) => {
    expect(awaitingLabel({ status: 'awaiting_user', awaitingReason })).toBe(label);
  });

  it.each(STATUSES.filter((s) => s !== 'awaiting_user'))('a reason left on a %s task says nothing', (status) => {
    expect(awaitingLabel({ status, awaitingReason: 'input' })).toBeNull();
  });

  it('says nothing for a wait with no saved reason', () => {
    expect(awaitingLabel({ status: 'awaiting_user' })).toBeNull();
  });

  it.each([
    [undefined, null],
    [0, null],
    [1, 'Waiting for approval'],
    [2, 'Waiting for approval (2)'],
  ])('%s approvals read %s', (count, label) => {
    expect(approvalLabel(count)).toBe(label);
  });

  it('refers to a task by its order, dotted under a parent', () => {
    expect(taskRef({ order: 3 })).toBe('#3');
    expect(taskRef({ order: 1 }, { order: 2 })).toBe('#2.1');
    expect(titledTaskRef({ order: 3, title: 'Deploy' })).toBe('#3 Deploy');
  });
});

describe('a report received while its attempt winds down (ADR-0018, L1)', () => {
  it.each([
    ['done', 'Completion received'],
    ['failed', 'Failure report received'],
    ['blocked', 'Blocked report received'],
  ] as const)('reads a %s report as "%s" on a task still running', (reported, label) => {
    const row = taskRowView(subject({ status: 'in_progress', completionReceived: reported }));
    expect(row.receipt).toBe(label);
    expect(row.status).toBe('running');
  });

  it('says nothing with no report, or once the task has left its attempt', () => {
    expect(taskRowView(subject({ status: 'in_progress' })).receipt).toBeNull();
    expect(taskRowView(subject({ status: 'completed', completionReceived: 'done' })).receipt).toBeNull();
    expect(taskRowView(subject({ status: 'failed', completionReceived: 'failed' })).receipt).toBeNull();
  });
});

describe('a runner starting while Ordewell\'s tools attach (ADR-0025)', () => {
  it('says its tools are connecting, and on the respawn that it is a retry', () => {
    expect(taskRowView(subject({ status: 'in_progress', attaching: 1 })).attaching).toBe('Connecting Ordewell\'s tools');
    expect(taskRowView(subject({ status: 'in_progress', attaching: 2 })).attaching).toBe('Connecting Ordewell\'s tools, retry');
    expect(taskRowView(subject({ status: 'in_progress', attaching: 1 })).status).toBe('running');
  });

  it('says nothing once they connected, or once the task has left its attempt', () => {
    expect(taskRowView(subject({ status: 'in_progress' })).attaching).toBeNull();
    expect(taskRowView(subject({ status: 'pending', attaching: 2 })).attaching).toBeNull();
  });
});

describe('a task paused on a usage limit', () => {
  const now = new Date(2026, 9, 11, 17, 0);
  const paused = { status: 'awaiting_user', type: 'ai' as const, awaitingReason: 'usage-limit' as const };

  it('shows no resume time when the saved one does not parse', () => {
    expect(resumeLabel({ ...paused, resumeAt: 'not a date' }, now)).toBeNull();
  });

  it('reads when it resumes, on the reader\'s clock, with the date when it is not today', () => {
    expect(resumeTime(new Date(2026, 9, 11, 20, 10), now)).toBe('8:10pm');
    expect(resumeTime(new Date(2026, 9, 11, 9, 0), now)).toBe('9am');
    expect(resumeTime(new Date(2026, 9, 14, 12, 5), now)).toBe('Oct 14, 12:05pm');
    expect(resumeLabel({ ...paused, resumeAt: new Date(2026, 9, 11, 20, 10).toISOString() }, now)).toBe('Resumes at 8:10pm');
  });

  it('offers to cancel the resume only while one is scheduled', () => {
    const resumeAt = new Date(2026, 9, 11, 20, 10).toISOString();
    expect(taskRowActions({ ...paused, resumeAt })).toEqual(['cancel-resume', 'skip', 'complete']);
    expect(taskRowActions({ ...paused, resumeAt }, 'subtask')).toEqual(['cancel-resume', 'complete']);
    expect(taskRowActions(paused)).toEqual(['skip', 'complete']);
    expect(taskRowView(subject({ ...paused, resumeAt }), { now }).resumes).toBe('Resumes at 8:10pm');
    expect(taskRowView(subject(paused), { now }).resumes).toBeNull();
  });

  it('offers to resume now when its session was saved, with or without a resume time, before not resuming', () => {
    const resumeAt = new Date(2026, 9, 11, 20, 10).toISOString();
    expect(taskRowActions({ ...paused, resumeAt, continuable: true })).toEqual(['resume-now', 'cancel-resume', 'skip', 'complete']);
    expect(taskRowActions({ ...paused, continuable: true })).toEqual(['resume-now', 'skip', 'complete']);
    expect(taskRowActions({ ...paused, resumeAt, continuable: true }, 'subtask')).toEqual(['resume-now', 'cancel-resume', 'complete']);
    expect(taskRowActions({ status: 'failed', type: 'ai', continuable: true })).not.toContain('resume-now');
    expect(taskRowActions({ status: 'awaiting_user', type: 'ai', awaitingReason: 'input', continuable: true })).not.toContain('resume-now');
  });

  it('says nothing of a resume time left on a task in any other state', () => {
    const resumeAt = new Date(2026, 9, 11, 20, 10).toISOString();
    expect(resumeLabel({ status: 'awaiting_user', awaitingReason: 'input', resumeAt })).toBeNull();
    expect(resumeLabel({ status: 'pending', awaitingReason: 'usage-limit', resumeAt })).toBeNull();
    expect(taskRowActions({ status: 'pending', type: 'ai', awaitingReason: 'usage-limit', resumeAt })).toEqual(['force-start']);
  });
});

describe('actions per status', () => {
  const table: [string, 'ai' | 'user', TaskRowAction[], TaskRowAction[]][] = [
    ['pending', 'ai', ['force-start'], ['force-start', 'skip']],
    ['approved', 'ai', ['force-start'], ['force-start', 'skip']],
    ['blocked', 'ai', ['skip', 'force-start'], []],
    ['in_progress', 'ai', ['cancel'], ['cancel', 'complete']],
    ['awaiting_user', 'ai', ['skip', 'complete'], ['complete']],
    ['completed', 'ai', ['uncomplete'], ['uncomplete']],
    ['failed', 'ai', ['skip'], ['skip']],
    ['skipped', 'ai', ['complete'], ['complete']],
    ['pending', 'user', ['complete'], ['skip']],
    ['approved', 'user', ['complete'], ['skip']],
    ['blocked', 'user', ['skip', 'complete'], []],
    ['in_progress', 'user', ['cancel', 'complete'], ['cancel']],
    ['awaiting_user', 'user', ['skip', 'complete'], ['complete']],
    ['completed', 'user', ['complete', 'uncomplete'], ['uncomplete']],
    ['failed', 'user', ['skip', 'complete'], ['skip']],
    ['skipped', 'user', ['complete'], ['complete']],
  ];

  it.each(table)('a %s %s task offers %j, as a subtask %j', (status, type, asTask, asSubtask) => {
    expect(taskRowActions({ status, type })).toEqual(asTask);
    expect(taskRowActions({ status, type }, 'subtask')).toEqual(asSubtask);
    expect(taskRowView(subject({ status, type })).actions).toEqual(asTask);
    expect(taskRowView(subject({ status, type }), { parent: { order: 1 } }).actions).toEqual(asSubtask);
  });

  it.each(STATUSES)('the mark toggle on a %s task', (status) => {
    expect(markAction({ status })).toBe(status === 'completed' ? 'uncomplete' : 'complete');
  });

  it.each(STATUSES)('ops can be flipped on a %s AI task only before it starts, never on a manual one', (status) => {
    expect(opsEditable({ status, type: 'ai' })).toBe(['pending', 'approved', 'blocked'].includes(status));
    expect(opsEditable({ status, type: 'user' })).toBe(false);
  });

  it.each([
    ['run', { command: 'run_task', task: 't1' }],
    ['retry', { command: 'retry_task', task: 't1', from: 'fresh' }],
    ['cancel', { command: 'stop_task', task: 't1' }],
    ['resume-now', { command: 'retry_task', task: 't1', from: 'session' }],
    ['cancel-resume', { command: 'cancel_resume', task: 't1' }],
    ['skip', { command: 'skip_task', task: 't1' }],
    ['force-start', { command: 'force_start', task: 't1' }],
    ['complete', { command: 'mark_complete', task: 't1' }],
    ['uncomplete', { command: 'mark_not_done', task: 't1' }],
  ] as const)('%s is the command %j', (action, command) => {
    expect(taskActionCommand(action, 't1')).toEqual(command);
  });

  it('carries the reason only on a skip', () => {
    expect(taskActionCommand('skip', 't1', 'not needed')).toEqual({ command: 'skip_task', task: 't1', reason: 'not needed' });
    expect(taskActionCommand('cancel', 't1', 'not needed')).toEqual({ command: 'stop_task', task: 't1' });
  });
});

describe('an override\'s yes (ADR-0029)', () => {
  it.each([['ai', true], ['script', true], ['user', false]] as const)('a %s task needs the user\'s yes: %s', (type, needs) => {
    expect(overrideNeedsConfirmation({ type })).toBe(needs);
  });

  it('puts the yes and the status the user was asked about on a mark, in either direction', () => {
    expect(confirmedOverride({ command: 'mark_complete', task: 't1' }, 'failed')).toEqual({ command: 'mark_complete', task: 't1', confirmed: true, seen: 'failed' });
    expect(confirmedOverride({ command: 'mark_not_done', task: 't1' }, 'completed')).toEqual({ command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' });
  });

  it('carries no status for a yes that never looked, as a scripted --yes gives', () => {
    expect(confirmedOverride({ command: 'mark_complete', task: 't1' })).toEqual({ command: 'mark_complete', task: 't1', confirmed: true });
  });

  it('words the question for each direction, naming what it leaves alone', () => {
    expect(manualOverrideConfirmation('complete', 'task #1 Fix')).toBe('Mark task #1 Fix complete? You vouch for its work although no passing verdict said it was done. Any changes it kept may land in your run, and the tasks that depend on it are released to start on a future run.');
    expect(manualOverrideConfirmation('uncomplete', 'task #1 Fix')).toBe('Mark task #1 Fix not done? This clears its completion and holds it until you retry or start it. The work it did stays where it is, and tasks that already ran on its result are not undone.');
  });

  it('tells the user to Stop the run first, in sentence case', () => {
    expect(manualOverrideStopFirst('complete', 'task #1 Fix')).toBe('Task #1 Fix cannot be marked complete while the plan is starting, running or waiting to resume, because the run could still move it on. Stop the run first, and mark it once everything has stopped.');
    expect(manualOverrideStopFirst('uncomplete', 'task #1 Fix')).toContain('cannot be marked not done');
  });

  it('leaves every other command as it was', () => {
    expect(confirmedOverride({ command: 'skip_task', task: 't1' }, 'pending')).toEqual({ command: 'skip_task', task: 't1' });
  });
});

describe('the research mark', () => {
  it('marks only an AI task as research', () => {
    expect(taskRowView(subject({ type: 'script', research: true })).research).toBe(false);
  });
});

describe('the compact handoff a row shows (ADR-0047)', () => {
  const finding = (id: string, severity: 'blocker' | 'major' | 'minor' | 'info') => ({ id, severity, title: id });

  it('is null for an attempt that handed nothing over, or a plan saved before handoffs', () => {
    expect(taskRowView(subject()).handoff).toBeNull();
  });

  it('carries the saved patch its attempt kept, when it saved one (ADR-0050)', () => {
    const patch = { kind: 'patch' as const, path: '.ordewell/sessions/s1/tasks/t1/1.patch', attempt: 1, base: 'a'.repeat(40), files: 2, added: 9, removed: 1, binary: 0, bytes: 900, sha256: 'f'.repeat(64) };
    const row = taskRowView(subject({
      status: 'completed',
      handoff: { summary: 'Tried it.', findings: [], findingCount: 0, artifacts: [patch] },
    }));

    expect(row.handoff?.patch?.peek).toBe('patch: 2 files, +9 -1');
    expect(taskRowView(subject({ status: 'completed', handoff: { summary: 's', findings: [], findingCount: 0 } })).handoff).not.toHaveProperty('patch');
  });

  it('carries the summary, the whole finding count and the worst severity the digest keeps', () => {
    const row = taskRowView(subject({
      status: 'completed',
      handoff: { summary: 'Added the route.', findings: [finding('F1', 'minor'), finding('F2', 'blocker'), finding('F3', 'major')], findingCount: 3 },
    }));

    expect(row.handoff).toEqual({ summary: 'Added the route.', findingCount: 3, severity: 'blocker' });
    expect(row.status).toBe('done');
  });

  it('carries the commit message a task stated, and leaves the key out when it stated none', () => {
    const commit = { subject: 'Add the route', body: 'Why it is needed.' };
    const stated = taskRowView(subject({ status: 'completed', handoff: { summary: 's', findings: [], findingCount: 0, commit } }));

    expect(stated.handoff).toEqual({ commit, summary: 's', findingCount: 0, severity: null });
    expect(taskRowView(subject({ status: 'completed', handoff: { summary: 's', findings: [], findingCount: 0 } })).handoff).not.toHaveProperty('commit');
  });

  it('keeps a count whose findings the digest left out, and says the severity it can see', () => {
    const row = taskRowView(subject({
      status: 'failed',
      handoff: { summary: 'The schema is missing.', findings: [finding('F1', 'major')], findingCount: 30 },
    }));

    expect(row.handoff).toEqual({ summary: 'The schema is missing.', findingCount: 30, severity: 'major' });
    expect(row.status).toBe('failed');
  });

  it('has no severity for a handoff with no findings, as a script and a user task leave', () => {
    expect(taskRowView(subject({ status: 'completed', type: 'script', handoff: { summary: 'exited 0 in 2.5 s', findings: [], findingCount: 0 } })).handoff)
      .toEqual({ summary: 'exited 0 in 2.5 s', findingCount: 0, severity: null });
    expect(taskRowView(subject({ status: 'completed', type: 'user', handoff: { summary: 'Completed by the user', findings: [], findingCount: 0 } })).handoff)
      .toEqual({ summary: 'Completed by the user', findingCount: 0, severity: null });
  });
});

describe('the row view, every status against every annotation', () => {
  const isolated = { branch: 'b', worktree: 'w', repos: ['.'] };
  const annotations: [string, Partial<TaskRowSubject>, (view: ReturnType<typeof taskRowView>, status: string) => void][] = [
    ['nothing', {}, (v) => {
      expect(v).toMatchObject({ conflict: null, repairing: null, repaired: null, mergeGate: null, opsChangedFiles: false, forcedPastGate: null, approvals: null, autonomous: false, waitsForApproval: null, holdReason: null, research: false, handoff: null });
    }],
    ['a conflict in a named repo', { isolation: { ...isolated, state: 'conflict', conflictRepo: 'api', conflictFiles: ['a', 'b', 'c', 'd', 'e', 'f'] } }, (v) => {
      expect(v.conflict).toEqual({ repo: 'api', files: 'a, b, c, d, e, +1 more' });
    }],
    ['a conflict at the root repo', { isolation: { ...isolated, state: 'conflict', conflictRepo: '.' } }, (v) => {
      expect(v.conflict).toEqual({ repo: null, files: null });
      expect(v.repos).toEqual([]);
    }],
    ['work in a repo group', { isolation: { ...isolated, state: 'active', repos: ['.', 'api', 'web'] } }, (v) => {
      expect(v.repos).toEqual(['api', 'web']);
    }],
    ['a repair with its attempt', { isolation: { ...isolated, state: 'repairing', conflictFiles: ['a'], repair: { attempt: 2, limit: 3 } } }, (v) => {
      expect(v.repairing).toEqual({ files: 'a', attempt: { attempt: 2, limit: 3 } });
      expect(v.conflict).toBeNull();
    }],
    ['a repair before the stream has its attempt', { isolation: { ...isolated, state: 'repairing' } }, (v) => {
      expect(v.repairing).toEqual({ files: null, attempt: null });
    }],
    ['repaired files, landed', { isolation: { ...isolated, state: 'integrated', repairedFiles: ['a'] } }, (v) => {
      expect(v.repaired).toEqual({ files: 'a', landed: true });
    }],
    ['repaired files, still repairing', { isolation: { ...isolated, state: 'repairing', repairedFiles: ['a'] } }, (v) => {
      expect(v.repaired).toEqual({ files: 'a', landed: false });
    }],
    ['work a revert can take back', { isolation: { ...isolated, state: 'integrated', revertible: true } }, (v) => {
      expect(v.revertible).toBe(true);
    }],
    ['landed work a revert cannot take', { isolation: { ...isolated, state: 'integrated' } }, (v) => {
      expect(v.revertible).toBe(false);
    }],
    ['no isolation at all', { isolation: { state: 'none' } }, (v) => {
      expect(v).toMatchObject({ conflict: null, repairing: null, repaired: null, repos: [] });
    }],
    ['a merge gate', { mergeGate: ['t1', 'ghost'] }, (v) => {
      expect(v.mergeGate).toEqual(['#1', 'ghost']);
    }],
    ['an empty merge gate', { mergeGate: [] }, (v) => {
      expect(v.mergeGate).toBeNull();
    }],
    ['a forced start', { forcedPastGate: ['Fix'] }, (v) => {
      expect(v.forcedPastGate).toEqual(['Fix']);
    }],
    ['changed files', { awaitingReason: 'files-changed', ops: true }, (v, status) => {
      expect(v.opsChangedFiles).toBe(status === 'awaiting_user');
      expect(v.awaiting).toBe(status === 'awaiting_user' ? 'Changed tracked files' : null);
    }],
    ['approvals', { awaitingApproval: 3 }, (v) => {
      expect(v.approvals).toBe('Waiting for approval (3)');
    }],
    // A task added after the user approved the plan waits for them until it starts; once at work, it was approved (ADR-0035).
    ['a start that waits for the user\'s approval', { waitsForApproval: true }, (v, status) => {
      expect(v.waitsForApproval).toBe(status === 'pending' || status === 'approved' || status === 'blocked' ? 'Waits for your approval' : null);
      expect(v.approvals).toBeNull();
    }],
    ['a hold with its reason', { holdReason: 'could not connect to Ordewell\'s tools; start it again' }, (v) => {
      expect(v.holdReason).toBe('could not connect to Ordewell\'s tools; start it again');
      expect(holdLabel(v.holdReason!)).toBe('On hold: could not connect to Ordewell\'s tools; start it again');
    }],
    ['a research task', { research: true }, (v) => {
      expect(v).toMatchObject({ research: true, kind: 'ai' });
    }],
    ['dependencies', { dependencies: ['t1', 'ghost'] }, (v) => {
      expect(v.dependencies).toEqual(['#1', 'ghost']);
    }],
    ['an autonomous mode', { taskMode: 'yolo' }, (v) => {
      expect(v.autonomous).toBe(true);
    }],
  ];

  const cases = STATUSES.flatMap((status) => annotations.map(([name, over, check]) => [status, name, over, check] as const));

  it.each(cases)('%s with %s', (status, _name, over, check) => {
    const view = taskRowView(subject({ status, ...over }), { tasks, modes: [{ id: 'yolo', autonomous: true }] });
    expect(view.status).toBe(taskStatusKind({ status }));
    check(view, status);
  });

  it('names the row by kind', () => {
    expect(taskRowView(subject()).kind).toBe('ai');
    expect(taskRowView(subject({ ops: true })).kind).toBe('ops');
    expect(taskRowView(subject({ type: 'user', ops: true })).kind).toBe('user');
    // An ops task by nature (ADR-0035), but drawn with its body, so it has a kind of its own.
    expect(taskRowView(subject({ type: 'script' })).kind).toBe('script');
    expect(taskRowView(subject({ type: 'script', ops: true })).kind).toBe('script');
  });

  it('offers a script task the force start an AI task gets, but never the ops toggle', () => {
    expect(taskRowActions({ status: 'pending', type: 'script' })).toEqual(['force-start']);
    expect(opsEditable({ status: 'pending', type: 'script' })).toBe(false);
  });

  it('labels a subtask by its dotted order', () => {
    expect(taskRowView(subject({ order: 1 }), { parent: { order: 2 } }).orderLabel).toBe('2.1');
    expect(taskRowView(subject()).orderLabel).toBe('2');
  });

  it('offers a subtask\'s actions to a subtask shown without its parent', () => {
    expect(taskRowView(subject({ status: 'in_progress' }), { placement: 'subtask' })).toMatchObject({ orderLabel: '2', actions: ['cancel', 'complete'] });
  });

  it('never marks a manual task autonomous, or one whose mode is untagged', () => {
    const modes = [{ id: 'yolo', autonomous: true }, { id: 'ask' }];
    expect(taskRowView(subject({ type: 'user', taskMode: 'yolo' }), { modes }).autonomous).toBe(false);
    expect(taskRowView(subject({ taskMode: 'ask' }), { modes }).autonomous).toBe(false);
    expect(taskRowView(subject({ taskMode: 'yolo' })).autonomous).toBe(false);
  });

  it('labels a dependency against the plan tree, so a sibling subtask reads dotted', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup' },
      { id: 't2', order: 2, title: 'Build', subtasks: [{ id: 's1', order: 1, title: 'Sibling' }, { id: 's2', order: 2, title: 'Other' }] },
      { id: 't3', order: 3, title: 'Test' },
    ];
    expect(taskRowView(subject({ id: 's2', order: 2, dependencies: ['s1'] }), { parent: { order: 2 }, tasks: tree }).dependencies).toEqual(['#2.1']);
    expect(taskRowView(subject({ dependencies: ['t3'] }), { tasks: tree }).dependencies).toEqual(['#3']);
    expect(taskRowView(subject({ id: 's2', order: 2, dependencies: ['t1'] }), { parent: { order: 2 }, tasks: tree }).dependencies).toEqual(['#1']);
  });

  it('shows a dependency by its id when there is no plan tree to label it against', () => {
    expect(taskRowView(subject({ dependencies: ['t1'] })).dependencies).toEqual(['t1']);
    expect(taskRowView(subject({ dependencies: ['t1'] }), { tasks: [] }).dependencies).toEqual(['t1']);
  });

  it('shows a task a failure blocks as blocked by the failed task, through its dependencies and in a subtask (ADR-0034)', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup', status: 'failed', dependencies: [] },
      { id: 't2', order: 2, title: 'Build', status: 'pending', dependencies: ['t1'], subtasks: [
        { id: 's1', order: 1, title: 'Sibling', status: 'failed', dependencies: [] },
        { id: 's2', order: 2, title: 'Other', status: 'approved', dependencies: ['s1'] },
      ] },
      { id: 't3', order: 3, title: 'Test', status: 'pending', dependencies: ['t2'] },
      { id: 't4', order: 4, title: 'Docs', status: 'pending', dependencies: [] },
    ];

    expect(taskRowView(subject({ id: 't3', order: 3, dependencies: ['t2'] }), { tasks: tree })).toMatchObject({ status: 'blocked', blockedBy: ['#1'] });
    expect(taskRowView(subject({ id: 's2', order: 2, status: 'approved', dependencies: ['s1'] }), { parent: { order: 2 }, tasks: tree })).toMatchObject({ status: 'blocked', blockedBy: ['#2.1'] });
    expect(taskRowView(subject({ id: 't4', order: 4 }), { tasks: tree })).toMatchObject({ status: 'todo', blockedBy: null });
    expect(taskRowView(subject({ id: 't3', order: 3, dependencies: ['t2'] }))).toMatchObject({ status: 'todo', blockedBy: null });
    expect(blockedByLabel(['#1', '#2.1'])).toBe('Blocked by #1, #2.1');
  });

  it('does not show a loop\'s check between rounds as blocking its dependents, until its loop stops (ADR-0045 L3)', () => {
    const tree = (fix: string) => [
      { id: 'c', order: 1, title: 'Review', status: 'failed', dependencies: [], loop: { body: ['f'], maxRounds: 3 }, verdict: { outcome: 'fail', reported: 'failed' } },
      { id: 'f', order: 2, title: 'Fix', status: fix, dependencies: ['c'] },
      { id: 'd', order: 3, title: 'Ship', status: 'pending', dependencies: ['c'] },
    ];

    expect(taskRowView(subject({ id: 'd', order: 3, dependencies: ['c'] }), { tasks: tree('in_progress') })).toMatchObject({ status: 'todo', blockedBy: null });
    expect(taskRowView(subject({ id: 'd', order: 3, dependencies: ['c'] }), { tasks: tree('failed') })).toMatchObject({ status: 'blocked', blockedBy: ['#1'] });
    const notRun = [{ ...tree('pending')[0], status: 'pending', verdict: null }, ...tree('pending').slice(1)];
    expect(taskRowView(subject({ id: 'd', order: 3, dependencies: ['c'] }), { tasks: notRun })).toMatchObject({ status: 'todo', blockedBy: null });
  });

  it('offers Skip on a task a failure blocks, though its own status is not blocked', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup', status: 'failed', dependencies: [] },
      { id: 't2', order: 2, title: 'Build', status: 'pending', dependencies: ['t1'] },
    ];

    expect(taskRowView(subject({ id: 't2', order: 2, dependencies: ['t1'] }), { tasks: tree }).actions).toEqual(['skip', 'force-start']);
  });

  it('shows a skipped task as skipped, with its reason, and releases what depends on it', () => {
    const tree = [
      { id: 't1', order: 1, title: 'Setup', status: 'skipped', dependencies: [] },
      { id: 't2', order: 2, title: 'Build', status: 'pending', dependencies: ['t1'] },
    ];

    expect(taskRowView(subject({ id: 't1', order: 1, status: 'skipped', skipReason: 'no GPU here' }), { tasks: tree })).toMatchObject({ status: 'skipped', skipReason: 'no GPU here', running: false });
    expect(taskRowView(subject({ id: 't1', order: 1, status: 'skipped' })).skipReason).toBeNull();
    expect(skippedLabel('no GPU here')).toBe('Skipped: no GPU here');
    expect(skippedLabel(null)).toBe('Skipped');
    expect(taskRowView(subject({ id: 't2', order: 2, dependencies: ['t1'] }), { tasks: tree })).toMatchObject({ status: 'todo', blockedBy: null });
  });

  it('marks a quiet task as still running', () => {
    expect(taskRowView(subject({ status: 'in_progress', idleSince: 'x' }))).toMatchObject({ status: 'quiet', running: true });
  });
});

describe('what a revert is confirmed with (ADR-0054)', () => {
  it('lists a task by order and title, and says which one goes with the task asked about', () => {
    expect(revertListLine({ order: 1, title: 'Parse JSON', repos: ['.'], dependent: false })).toBe('#1 Parse JSON');
    expect(revertListLine({ order: 2, title: 'Wire it up', repos: ['.'], dependent: true })).toBe('#2 Wire it up (goes with it)');
  });

  it('names the repos only when the work went beyond the workspace\'s own', () => {
    expect(revertListLine({ order: 3, title: 'Both', repos: ['api', 'web'], dependent: true })).toBe('#3 Both (api, web) (goes with it)');
  });

  it('says what it does to the branch and to the tasks, and that the user\'s branch is untouched', () => {
    expect(revertEffect).toContain('integration branch');
    expect(revertEffect).toContain('held as not started');
    expect(revertEffect).toContain('Nothing in your own branch changes');
  });
});

describe('texts', () => {
  const plan = [
    { id: 'a', order: 1, title: 'Fix', subtasks: [{ id: 'a1', order: 1, title: 'Nested' }] },
    { id: 'b', order: 2, title: 'Deploy' },
  ];

  it('names tasks by order and title, subtasks dotted, and a missing one by id', () => {
    expect(titledRefs(['a', 'a1', 'ghost'], plan)).toEqual(['#1 Fix', '#1.1 Nested', 'ghost']);
  });

  it('names nested dependents in a removal notice, with a fallback for a task that left the tree', () => {
    expect(dependentsNotice([
      { id: 'a1', order: 1, title: 'Nested' },
      { id: 'gone', order: 3, title: 'Gone' },
    ], plan)).toBe('2 tasks depend on it and will lose that dependency: #1.1 Nested, #3 Gone.');
  });

  it.each([
    [[], null],
    [[{ order: 2, title: 'Build' }], '1 task depends on it and will lose that dependency: #2 Build.'],
    [[{ order: 2, title: 'Build' }, { order: 3, title: 'Test' }], '2 tasks depend on it and will lose that dependency: #2 Build, #3 Test.'],
  ])('says what a removal does to %j', (dependents, notice) => {
    expect(dependentsNotice(dependents)).toBe(notice);
  });

  it('asks before a start past the merge gate, from the asking surface\'s subject', () => {
    expect(pastGateConfirmation(['#1 Fix', 'ghost'])).toBe(
      'This task waits for Merge all: the work of #1 Fix, ghost is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.',
    );
    expect(pastGateConfirmation(['#1 Fix'], 'It')).toMatch(/^It waits for Merge all: /);
  });

  it.each([
    ['Docs', undefined, { title: 'Docs', description: 'Docs', prompt: 'Docs', type: 'ai' }],
    ['  Docs ', '  ', { title: 'Docs', description: 'Docs', prompt: 'Docs', type: 'ai' }],
    ['Docs', 'write them\n', { title: 'Docs', description: 'Docs', prompt: 'write them\n', type: 'ai' }],
    ['   ', 'anything', null],
  ])('a hand-added %j with prompt %j starts as %j', (title, prompt, fields) => {
    expect(newTaskFields(title, prompt)).toEqual(fields);
  });

  it.each([
    ['script', 'A script task runs no model, so it has no runner.'],
    ['manual', 'Manual tasks do not run an executor, so they have no runner.'],
  ])('words the refusal to give a %s task an executor choice for that type', (type, refusal) => {
    expect(noExecutorRefusal(type, 'they have no runner.', 'it has no runner.')).toBe(refusal);
  });
});

describe('whether a row\'s task has a chat', () => {
  const chat = (over: Partial<TaskRowSubject>): boolean => taskRowView(subject(over)).chatAvailable;
  const ledgerEntry = { attempt: 1, runner: 'claude-code', startedAt: '2026-10-01T00:00:00Z', wallTimeMs: 0, totals: {}, byModel: [] };

  it('is absent before any attempt starts, whatever the status says', () => {
    for (const status of ['pending', 'approved', 'blocked', 'completed', 'failed', 'skipped']) {
      expect(chat({ status }), status).toBe(false);
    }
  });

  it('is there once an attempt has started, and stays after any ending or a return to pending', () => {
    for (const status of ['in_progress', 'awaiting_user', 'completed', 'failed', 'skipped', 'pending']) {
      expect(chat({ status, attempted: true }), status).toBe(true);
    }
  });

  it('reads the attempt ledger of a plan saved before the flag', () => {
    expect(chat({ status: 'completed', attemptUsage: [ledgerEntry] })).toBe(true);
    expect(chat({ status: 'pending', attemptUsage: [] })).toBe(false);
  });

  it('is a script task\'s own, with no ledger to count', () => {
    expect(chat({ type: 'script', status: 'in_progress', attempted: true })).toBe(true);
    expect(chat({ type: 'script', status: 'completed' })).toBe(false);
  });

  it('is never a manual task\'s, even if a stray mark says otherwise', () => {
    expect(chat({ type: 'user', status: 'completed', attempted: true })).toBe(false);
    expect(chat({ type: 'user', status: 'pending', attemptUsage: [ledgerEntry] })).toBe(false);
  });
});

describe('the runner a row shows — only an AI task has one', () => {
  it('is the assigned runner of an AI task, an ops task included', () => {
    expect(taskRowView(subject({ assignedRunner: 'codex' })).runner).toBe('codex');
    expect(taskRowView(subject({ assignedRunner: 'codex', ops: true })).runner).toBe('codex');
  });

  it.each(['script', 'user'] as const)('is nothing for a %s task, whatever runner the plan holds for it', (type) => {
    expect(taskRowView(subject({ type, assignedRunner: 'opencode' })).runner).toBeNull();
  });

  it('is nothing for an AI task that holds no runner', () => {
    expect(taskRowView(subject()).runner).toBeNull();
  });

  it.each(['script', 'user'] as const)('flags a %s task for a runner that is off in no scope: it has none to be off', (type) => {
    const scope = { enabledRunners: ['claude-code'], allowlist: {} };
    expect(taskRowView(subject({ type, assignedRunner: 'opencode' }), { runnerScope: scope }).assignmentFlag).toBeNull();
  });
});

describe('the assignment flag — a task on a runner or model the user has since moved away from', () => {
  const scope = { enabledRunners: ['claude-code'], allowlist: { 'claude-code': ['claude-sonnet-4'] } };
  const flag = (over: Partial<TaskRowSubject>, context = { runnerScope: scope }) => taskRowView(subject(over), context).assignmentFlag;

  it('says nothing without a scope to read the assignment against', () => {
    expect(taskRowView(subject({ assignedRunner: 'codex' })).assignmentFlag).toBeNull();
  });

  it('flags a task whose runner is switched off', () => {
    expect(flag({ assignedRunner: 'codex' })).toBe('codex is switched off');
  });

  it('flags a task whose model is off the runner\'s allowlist, by its label', () => {
    expect(flag({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })).toBe('Opus 4 is not in the allowlist');
  });

  it('names the runner alone when both are wrong', () => {
    expect(flag({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } })).toBe('codex is switched off');
  });

  it('says nothing for an allowlisted model, an unrestricted runner or an unset allowlist', () => {
    expect(flag({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Sonnet 4' } })).toBeNull();
    const open = { enabledRunners: ['claude-code', 'codex'], allowlist: { 'claude-code': [] as string[] } };
    expect(flag({ assignedRunner: 'claude-code', assignedModel: { modelId: 'anything', modelLabel: 'Anything' } }, { runnerScope: open })).toBeNull();
    expect(flag({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } }, { runnerScope: open })).toBeNull();
  });

  it.each(['completed', 'skipped'])('says nothing for a %s task: its work is over', (status) => {
    expect(flag({ status, assignedRunner: 'codex' })).toBeNull();
  });

  it('says nothing for a manual task, which has no runner', () => {
    expect(flag({ type: 'user', assignedRunner: 'codex' })).toBeNull();
  });

  it('flags a running task too: it keeps running, and the row says why it might be moved', () => {
    expect(flag({ status: 'in_progress', assignedRunner: 'codex' })).toBe('codex is switched off');
  });
});

describe('what the assignment flag means for the task, by where it stands', () => {
  const scope = { enabledRunners: ['claude-code'], allowlist: {} };
  const consequence = (over: Partial<TaskRowSubject>) => taskRowView(subject({ assignedRunner: 'codex', ...over }), { runnerScope: scope }).assignmentConsequence;

  it.each([
    [{ status: 'pending' }, 'runs as assigned unless moved'],
    [{ status: 'in_progress' }, 'already running as assigned'],
    [{ status: 'failed' }, 'failed; a retry would run it there unless moved'],
    [{ status: 'awaiting_user', awaitingReason: 'usage-limit' as const, resumeAt: '2099-01-01T00:00:00.000Z' }, 'paused on a usage limit; resumes there at the reset unless moved'],
    [{ status: 'awaiting_user', awaitingReason: 'usage-limit' as const }, 'paused on a usage limit; a retry would run it there unless moved'],
    [{ status: 'awaiting_user', awaitingReason: 'conflict' as const }, 'waiting for the user; what runs next runs there unless moved'],
    [{ status: 'awaiting_user', awaitingReason: 'files-changed' as const }, 'waiting for the user; what runs next runs there unless moved'],
    [{ status: 'awaiting_user', awaitingReason: 'checkpoint' as const }, 'already running as assigned'],
  ])('%j reads %j', (over, text) => {
    expect(consequence(over)).toBe(text);
  });

  it('is null when the task is not flagged', () => {
    expect(consequence({ status: 'pending', assignedRunner: 'claude-code' })).toBeNull();
  });
});

describe('a task row\'s usage', () => {
  const attempt = (n: number, over: Record<string, unknown> = {}) => ({ attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 1000, totals: {}, ...over });

  it('is the task\'s whole spend across attempts, with the meter of the latest', () => {
    const usage = taskRowView(subject({
      status: 'completed',
      attemptUsage: [
        attempt(1, { totals: { inputTokens: 100, reportedCost: { USD: 1 } }, lastPromptTokens: 90, contextWindow: 100 }),
        attempt(2, { totals: { inputTokens: 20, outputTokens: 5 }, lastPromptTokens: 20, contextWindow: 200 }),
      ],
    })).usage;
    expect(usage?.totals).toEqual({ inputTokens: 120, outputTokens: 5, reportedCost: { USD: 1 } });
    expect(usage?.contextFill).toEqual({ usedTokens: 20, windowTokens: 200 });
    expect(usage?.attempt).toBe(2);
    expect(usage).not.toHaveProperty('byModel');
    expect(usage).not.toHaveProperty('wallTimeMs');
  });

  it('carries the latest attempt\'s used tokens while its window is unknown', () => {
    const usage = taskRowView(subject({
      status: 'completed',
      attemptUsage: [attempt(1, { totals: { inputTokens: 100 }, lastPromptTokens: 90, contextWindow: 100 }), attempt(2, { totals: { inputTokens: 20 }, lastPromptTokens: 20 })],
    })).usage;
    expect(usage?.contextFill).toEqual({ usedTokens: 20 });
  });
});
