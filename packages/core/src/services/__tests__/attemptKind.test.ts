import { describe, it, expect, vi } from 'vitest';
import {
  attemptCwd, attemptPrompt, checksTree, classifyAttempt, decidesIsolation, mergeExcludes,
  type AttemptKind, type AttemptPromptSources,
} from '../attemptKind';
import { createTask, opsFlag, inheritedOps } from '../../models/Task';

const repair = { n: 1, limit: 2 };
const resume = { message: 'one more thing', resumeSessionId: 'sess-1' };

const KINDS: Record<string, AttemptKind> = {
  change: classifyAttempt(false),
  ops: classifyAttempt(true),
  repair: classifyAttempt(false, { repair }),
  'continued change': classifyAttempt(false, { continuation: resume }),
  'continued ops': classifyAttempt(true, { continuation: resume }),
};

describe('classifyAttempt', () => {
  it('reads a fresh attempt from the task alone', () => {
    expect(classifyAttempt(false)).toEqual({ kind: 'change' });
    expect(classifyAttempt(true)).toEqual({ kind: 'ops' });
  });

  it('carries what a repair or a continue is owed', () => {
    expect(classifyAttempt(false, { repair })).toEqual({ kind: 'repair', repair });
    expect(classifyAttempt(true, { continuation: resume })).toEqual({ kind: 'continuation', ops: true, ...resume });
  });

  it('lets a repair outrank the ops mark, and a continue outrank a repair', () => {
    expect(classifyAttempt(true, { repair }).kind).toBe('repair');
    expect(classifyAttempt(false, { repair, continuation: resume }).kind).toBe('continuation');
  });
});

describe('what each kind decides', () => {
  const table: Array<[string, { mergeExcludes: boolean; decidesIsolation: boolean; checksTree: boolean; cwd: string }]> = [
    ['change', { mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'run' }],
    ['ops', { mergeExcludes: true, decidesIsolation: false, checksTree: true, cwd: 'workspace' }],
    ['repair', { mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'kept' }],
    ['continued change', { mergeExcludes: false, decidesIsolation: true, checksTree: false, cwd: 'run' }],
    ['continued ops', { mergeExcludes: true, decidesIsolation: false, checksTree: true, cwd: 'workspace' }],
  ];

  it.each(table)('a %s attempt', async (name, expected) => {
    const kind = KINDS[name];
    const runs = {
      attemptCwd: vi.fn(async (_t: unknown, opts: { repair: boolean }) => ({ cwd: opts.repair ? 'kept' : 'run', worktree: true })),
      workspaceCwd: vi.fn(async () => ({ cwd: 'workspace', worktree: false })),
    };

    const place = await attemptCwd(kind, createTask({ id: 't1' }), runs);

    expect({
      mergeExcludes: mergeExcludes(kind),
      decidesIsolation: decidesIsolation(kind),
      checksTree: checksTree(kind),
      cwd: place.cwd,
    }).toEqual(expected);
    expect(runs.attemptCwd.mock.calls.length + runs.workspaceCwd.mock.calls.length).toBe(1);
  });
});

describe('mergeExcludes: the one rule Merge all and ops work share (ADR-0020)', () => {
  it.each([
    ['change', false],
    ['ops', true],
    ['repair', false],
    ['continued change', false],
    ['continued ops', true],
  ])('%s attempt — excluded: %s', (name, excluded) => {
    expect(mergeExcludes(KINDS[name])).toBe(excluded);
  });

  it('holds back a fresh ops task exactly when the ops mark does', () => {
    expect(mergeExcludes(classifyAttempt(true))).toBe(true);
    expect(mergeExcludes(classifyAttempt(false))).toBe(false);
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
    };
  }

  const table: Array<[string, { has: string[]; lacks: string[]; reads: Array<'repairPrompt' | 'previousAttempt'> }]> = [
    ['change', { has: ['ORIGINAL BODY', '### Skill: tdd'], lacks: ['## Previous attempt'], reads: [] }],
    ['ops', { has: ['ORIGINAL BODY', '### Skill: tdd', '## Previous attempt', 'created resource group rg-dev'], lacks: [], reads: ['previousAttempt'] }],
    ['repair', { has: ['MERGE THE INTEGRATION BRANCH'], lacks: ['ORIGINAL BODY', '### Skill: tdd', '## Previous attempt'], reads: ['repairPrompt'] }],
    ['continued change', { has: ['Your working directory was recreated'], lacks: ['ORIGINAL BODY', '### Skill: tdd'], reads: [] }],
    ['continued ops', { has: ['in the same checkout', 'was not undone'], lacks: ['ORIGINAL BODY', '## Previous attempt'], reads: [] }],
  ];

  it.each(table)('a %s attempt', (name, expected) => {
    const src = sources();

    const prompt = attemptPrompt(KINDS[name], src);

    for (const text of expected.has) expect(prompt).toContain(text);
    for (const text of expected.lacks) expect(prompt).not.toContain(text);
    expect(prompt).toContain('task_complete');
    if (KINDS[name].kind === 'continuation') expect(prompt.startsWith(`${resume.message}\n`)).toBe(true);
    for (const source of ['repairPrompt', 'previousAttempt'] as const) {
      expect(src[source].mock.calls.length > 0, source).toBe(expected.reads.includes(source));
    }
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
