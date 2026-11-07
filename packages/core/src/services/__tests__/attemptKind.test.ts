import { describe, it, expect, vi } from 'vitest';
import {
  attemptPrompt, attemptWorkspace, checksTree, classifyAttempt, decidesIsolation, landsNothing, mergeExcludes, takesSkills, writesCommit,
  type AttemptKind, type AttemptPromptSources, type TaskWork,
} from '../attemptKind';
import { createTask, opsFlag, inheritedOps, type Task } from '../../models/Task';

const repair = { n: 1, limit: 2 };
const resume = { message: 'one more thing', resumeSessionId: 'sess-1' };

const KINDS: Record<string, AttemptKind> = {
  change: classifyAttempt('change'),
  ops: classifyAttempt('ops'),
  repair: classifyAttempt('change', { repair }),
  'continued change': classifyAttempt('change', { continuation: resume }),
  'continued ops': classifyAttempt('ops', { continuation: resume }),
  'carried-over change': classifyAttempt('change', { carriedFrom: 'codex' }),
  'read-only': classifyAttempt('readOnly'),
  'continued read-only': classifyAttempt('readOnly', { continuation: resume }),
};

describe('classifyAttempt', () => {
  it('reads a fresh attempt from the task alone', () => {
    expect(classifyAttempt('change')).toEqual({ kind: 'change' });
    expect(classifyAttempt('ops')).toEqual({ kind: 'ops' });
  });

  it('carries what a repair or a continue is owed', () => {
    expect(classifyAttempt('change', { repair })).toEqual({ kind: 'repair', repair });
    expect(classifyAttempt('ops', { continuation: resume })).toEqual({ kind: 'continuation', work: 'ops', ...resume });
  });

  it('lets a repair outrank the ops mark, and a continue outrank a repair', () => {
    expect(classifyAttempt('ops', { repair }).kind).toBe('repair');
    expect(classifyAttempt('change', { repair, continuation: resume }).kind).toBe('continuation');
  });

  it('carries a paused change task\'s work over to its new runner, naming the runner it left', () => {
    expect(classifyAttempt('change', { carriedFrom: 'codex' })).toEqual({ kind: 'carryOver', from: 'codex' });
  });

  it('reads a read-only task as one that lands nothing, fresh or continued (ADR-0046)', () => {
    expect(classifyAttempt('readOnly')).toEqual({ kind: 'readOnly' });
    expect(classifyAttempt('readOnly', { continuation: resume })).toEqual({ kind: 'continuation', work: 'readOnly', ...resume });
    for (const [name, kind] of Object.entries(KINDS)) expect(landsNothing(kind), name).toBe(name.endsWith('read-only'));
  });

  it('carries nothing over for a read-only task, whose worktree was thrown away', () => {
    expect(classifyAttempt('readOnly', { carriedFrom: 'codex' })).toEqual({ kind: 'readOnly' });
    expect(takesSkills(classifyAttempt('readOnly'))).toBe(true);
  });

  it('carries nothing over for an ops task, whose work is never in a worktree, and lets a repair or a continue outrank it', () => {
    expect(classifyAttempt('ops', { carriedFrom: 'codex' })).toEqual({ kind: 'ops' });
    expect(classifyAttempt('change', { repair, carriedFrom: 'codex' }).kind).toBe('repair');
    expect(classifyAttempt('change', { continuation: resume, carriedFrom: 'codex' }).kind).toBe('continuation');
  });
});

describe('what each kind decides', () => {
  const table: Array<[string, { writesCommit: boolean; mergeExcludes: boolean; decidesIsolation: boolean; checksTree: boolean; cwd: string }]> = [
    ['change', { writesCommit: true, mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'fresh' }],
    ['ops', { writesCommit: false, mergeExcludes: true, decidesIsolation: false, checksTree: true, cwd: 'workspace' }],
    ['repair', { writesCommit: false, mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'kept' }],
    ['continued change', { writesCommit: true, mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'restored' }],
    ['continued ops', { writesCommit: false, mergeExcludes: true, decidesIsolation: false, checksTree: true, cwd: 'workspace' }],
    ['carried-over change', { writesCommit: true, mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'restored' }],
    ['read-only', { writesCommit: false, mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'throwaway' }],
    ['continued read-only', { writesCommit: false, mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'throwaway' }],
  ];

  it.each(table)('a %s attempt', (name, expected) => {
    const kind = KINDS[name];
    const workspace = attemptWorkspace(kind);

    expect({
      writesCommit: writesCommit(kind),
      mergeExcludes: mergeExcludes(kind),
      decidesIsolation: decidesIsolation(kind),
      checksTree: checksTree(kind),
      cwd: workspace.kind === 'checkout' ? 'workspace' : { fresh: 'fresh', repair: 'kept', restore: 'restored', readOnly: 'throwaway' }[workspace.intent],
    }).toEqual(expected);
  });
});

describe('mergeExcludes: the one rule Merge all and ops work share (ADR-0020)', () => {
  it.each([
    ['change', false],
    ['ops', true],
    ['repair', false],
    ['continued change', false],
    ['continued ops', true],
    ['carried-over change', false],
    ['read-only', false],
    ['continued read-only', false],
  ])('%s attempt — excluded: %s', (name, excluded) => {
    expect(mergeExcludes(KINDS[name])).toBe(excluded);
  });

  it('holds back a fresh ops task exactly when the ops mark does', () => {
    expect(mergeExcludes(classifyAttempt('ops'))).toBe(true);
    expect(mergeExcludes(classifyAttempt('change'))).toBe(false);
  });
});

describe('attemptPrompt', () => {
  const task = createTask({ id: 't1', title: 'Deploy', prompt: 'ORIGINAL BODY' });

  function sources(): AttemptPromptSources & { repairPrompt: ReturnType<typeof vi.fn>; previousAttempt: ReturnType<typeof vi.fn> } {
    return {
      task,
      plan: [task],
      planMapEnabled: false,
      skills: [{ name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md', content: 'RED then GREEN.' }],
      repairPrompt: vi.fn(() => 'MERGE THE INTEGRATION BRANCH'),
      previousAttempt: vi.fn(() => 'created resource group rg-dev'),
      previousHandoff: () => undefined,
    };
  }

  const table: Array<[string, { has: string[]; lacks: string[]; reads: Array<'repairPrompt' | 'previousAttempt'> }]> = [
    ['change', { has: ['ORIGINAL BODY', '### Skill: tdd'], lacks: ['## Previous attempt', 'save_patch'], reads: [] }],
    ['ops', { has: ['ORIGINAL BODY', '### Skill: tdd', '## Previous attempt', 'created resource group rg-dev'], lacks: [], reads: ['previousAttempt'] }],
    ['repair', { has: ['MERGE THE INTEGRATION BRANCH'], lacks: ['ORIGINAL BODY', '### Skill: tdd', '## Previous attempt'], reads: ['repairPrompt'] }],
    ['continued change', { has: ['Check the working tree'], lacks: ['ORIGINAL BODY', '### Skill: tdd'], reads: [] }],
    ['continued ops', { has: ['in the same checkout', 'was not undone'], lacks: ['ORIGINAL BODY', '## Previous attempt'], reads: [] }],
    ['carried-over change', { has: ['ORIGINAL BODY', '### Skill: tdd', 'previous attempt on codex', 'may be unfinished'], lacks: ['## Previous attempt'], reads: [] }],
    ['read-only', { has: ['ORIGINAL BODY', '### Skill: tdd', 'keep it with the `save_patch` tool before you finish'], lacks: ['## Previous attempt'], reads: [] }],
    ['continued read-only', { has: ['nothing your earlier attempt changed was kept'], lacks: ['ORIGINAL BODY', 'Your previous changes are in the working tree'], reads: [] }],
  ];

  it.each(table)('a %s attempt', (name, expected) => {
    const src = sources();

    const prompt = attemptPrompt(KINDS[name], src);

    for (const text of expected.has) expect(prompt).toContain(text);
    for (const text of expected.lacks) expect(prompt).not.toContain(text);
    // The contract is the runner's instructions, the same for every kind.
    expect(prompt).not.toContain('task_complete');
    if (KINDS[name].kind === 'continuation') expect(prompt.startsWith(`${resume.message}\n`)).toBe(true);
    for (const source of ['repairPrompt', 'previousAttempt'] as const) {
      expect(src[source].mock.calls.length > 0, source).toBe(expected.reads.includes(source));
    }
  });

  it('composes the next round of an AI check between rounds from its previous handoff', () => {
    const check = createTask({ id: 'check', prompt: 'Review again.', status: 'failed', loop: { body: ['fix'], maxRounds: 3 },
      verdict: { outcome: 'fail', reported: 'failed', reason: 'Holes', checks: [], decidedAt: 'x' },
    });
    const previousHandoff = vi.fn(() => ({ summary: 'A hole.', findings: [{ id: 'F1', severity: 'major' as const, title: 'Comma lost' }], findingCount: 1 }));

    const prompt = attemptPrompt({ kind: 'readOnly' }, { ...sources(), task: check, plan: [check], previousHandoff });

    expect(prompt).toContain('You are the check, round 2 of 3.');
    expect(prompt).toContain('F1 [major] Comma lost');
    expect(previousHandoff).toHaveBeenCalledWith('check');
  });

  it('tells an AI check its round and that its status is the verdict from round 1, but not the repair of its merge', () => {
    const check = createTask({ id: 'check', prompt: 'Review.', loop: { body: ['fix'], maxRounds: 3 } });
    const src = { ...sources(), task: check, plan: [check] };

    for (const kind of ['read-only', 'change', 'carried-over change'] as const) {
      const prompt = attemptPrompt(KINDS[kind], src);
      expect(prompt, kind).toContain('## You are this loop\'s check');
      expect(prompt, kind).toContain('This is round 1 of 3.');
      expect(prompt, kind).not.toContain('## Since your last round');
    }
    expect(attemptPrompt(KINDS.repair, src)).not.toContain('## You are this loop\'s check');
  });

  it('reminds a continued AI check that its status is the verdict, and no other continued task', () => {
    const check = createTask({ id: 'check', prompt: 'Review.', loop: { body: ['fix'], maxRounds: 3 } });

    expect(attemptPrompt(KINDS['continued read-only'], { ...sources(), task: check, plan: [check] })).toContain(
      'You are this loop\'s check: your `task_complete` status is its verdict, `failed` when you confirm any problem and `done` only when you confirm none.',
    );
    expect(attemptPrompt(KINDS['continued read-only'], sources())).not.toContain('loop\'s check');
  });

  it('keeps a legacy check report when resuming between rounds without a handoff', () => {
    const check = createTask({ id: 'check', prompt: 'Review again.', status: 'failed', loop: { body: ['fix'], maxRounds: 3 },
      verdict: { outcome: 'fail', reported: 'failed', reason: 'Holes', checks: [], decidedAt: 'x' },
      outputSummary: { reviewReason: 'Holes', report: 'A missing comma breaks parsing.', logTail: '', capturedAt: 'x' },
    });

    const prompt = attemptPrompt({ kind: 'readOnly' }, { ...sources(), task: check, plan: [check] });

    expect(prompt).toContain('You are the check, round 2 of 3.');
    expect(prompt).toContain('Your previous findings are not structured.');
    expect(prompt).toContain('A missing comma breaks parsing.');
    expect(prompt).not.toContain('(no previous report captured)');
  });

  it('tells a carried-over attempt its files come from the runner it left, in a fresh session', () => {
    const prompt = attemptPrompt(KINDS['carried-over change'], { ...sources(), previousWork: { outcome: 'restored' } });

    expect(prompt).toContain('## Work carried over');
    expect(prompt).toContain('The files in your working tree come from a previous attempt on codex');
    expect(prompt).toContain('may be unfinished');
    expect(prompt.indexOf('## Work carried over')).toBeLessThan(prompt.indexOf('ORIGINAL BODY'));
  });

  it('tells a carried-over attempt whose work could not be applied that it starts fresh, and where that work is', () => {
    const branch = 'ordewell-preserved/run1/1-deploy';
    const prompt = attemptPrompt(KINDS['carried-over change'], {
      ...sources(),
      previousWork: { outcome: 'fallback', preserved: [{ repo: '.', branch, commit: 'abc1234' }] },
    });

    expect(prompt).toContain('could not be applied');
    expect(prompt).toContain('starts fresh at the integration tip');
    expect(prompt).toContain(`git log ${branch}`);
    expect(prompt).toContain(`git diff HEAD...${branch}`);
    expect(prompt).not.toContain('The files in your working tree come from');
  });
});

describe('the ops flag', () => {
  it.each([
    [true, 'ai', true],
    [true, undefined, true],
    [true, 'user', undefined],
    ['true', 'ai', undefined],
    [false, 'ai', undefined],
    [undefined, 'ai', undefined],
    [1, 'ai', undefined],
  ] as const)('reads %j on a %s task as %s', (value, type, expected) => {
    expect(opsFlag(value, type)).toBe(expected);
  });

  it.each([
    ['every source ops', [{ ops: true }, { ops: true }], undefined, true],
    ['one source a change', [{ ops: true }, {}], undefined, false],
    ['a quoted flag on a source', [{ ops: 'true' as unknown as boolean }], undefined, false],
    ['a choice over the sources', [{ ops: true }], false, false],
    ['a choice of ops over changes', [{}, {}], true, true],
  ])('inherits with %s', (_label, from, chosen, expected) => {
    expect(inheritedOps(from, chosen)).toBe(expected);
  });
});

describe('a delegated task\'s attempt (ADR-0055 D3)', () => {
  const continued = (work: TaskWork): AttemptKind => classifyAttempt(work, { continuation: { message: 'go on', resumeSessionId: 'child-1' } });
  const sources = (task: Partial<Task>) => ({ task: task as Task, plan: [], skills: [], repairPrompt: () => '', previousAttempt: () => undefined, previousHandoff: () => undefined });

  it('is its own kind, read-only or not, and a repair outranks either', () => {
    expect(classifyAttempt('delegated')).toEqual({ kind: 'delegated', readOnly: false });
    expect(classifyAttempt('delegatedReadOnly')).toEqual({ kind: 'delegated', readOnly: true });
    expect(classifyAttempt('delegated', { repair: { n: 1, limit: 2 } }).kind).toBe('repair');
  });

  it('reopens its child\'s code root on a Continue, read-only or not, and a fresh read-only one is thrown away (ADR-0055 D17)', () => {
    expect(attemptWorkspace(continued('delegatedReadOnly'))).toEqual({ kind: 'worktree', intent: 'restore' });
    expect(attemptWorkspace(continued('delegated'))).toEqual({ kind: 'worktree', intent: 'restore' });
    expect(attemptWorkspace(classifyAttempt('delegatedReadOnly'))).toEqual({ kind: 'worktree', intent: 'readOnly' });
  });

  it('lands unless it is read-only, and names the commit its landing is written from', () => {
    expect(landsNothing(classifyAttempt('delegated'))).toBe(false);
    expect(landsNothing(classifyAttempt('delegatedReadOnly'))).toBe(true);
    expect(landsNothing(continued('delegatedReadOnly'))).toBe(true);
    expect(writesCommit(classifyAttempt('delegated'))).toBe(true);
    expect(writesCommit(classifyAttempt('delegatedReadOnly'))).toBe(false);
    expect(writesCommit(continued('delegated'))).toBe(true);
  });

  it('runs in a worktree of its own: a read-only one in a throwaway, a continued one in what it left', () => {
    expect(attemptWorkspace(classifyAttempt('delegated'))).toEqual({ kind: 'worktree', intent: 'fresh' });
    expect(attemptWorkspace(classifyAttempt('delegatedReadOnly'))).toEqual({ kind: 'worktree', intent: 'readOnly' });
    expect(attemptWorkspace(continued('delegated'))).toEqual({ kind: 'worktree', intent: 'restore' });
  });

  it('takes no skills and never excludes a merge', () => {
    const kind = classifyAttempt('delegated');
    expect(takesSkills(kind)).toBe(false);
    expect(mergeExcludes(kind)).toBe(false);
  });

  it('is told its goal, not a runner\'s brief', () => {
    expect(attemptPrompt(classifyAttempt('delegated'), sources({ goal: 'Reach it', type: 'delegated' }))).toBe('Reach it');
    expect(attemptPrompt(classifyAttempt('delegated'), sources({ type: 'delegated' }))).toBe('');
  });
});
