import { describe, it, expect } from 'vitest';
import { checkHandoff, handoffPreviewLines, handoffReferenceText, handoffWakeLines, parseFindingRef, readableTaskIds, savedPatchOf, severityLabel, storedHandoff, withPatch, worstSeverity, type HandoffDigest, type HandoffPatch } from '../Handoff';
import { createTask } from '../Task';

describe('the tasks a task may read (ADR-0047)', () => {
  // setup ← build ← check ⇄ fix (the check's loop body), docs beside them, and a subtask under build.
  const plan = [
    createTask({ id: 'setup', order: 1 }),
    createTask({ id: 'build', order: 2, dependencies: ['setup'], subtasks: [createTask({ id: 'build.1', order: 1, dependencies: ['setup'] })] }),
    createTask({ id: 'check', order: 3, dependencies: ['build'], loop: { body: ['fix'], maxRounds: 3 } }),
    createTask({ id: 'fix', order: 4, dependencies: ['check'] }),
    createTask({ id: 'docs', order: 5 }),
  ];

  it('is the task itself and its dependencies, followed all the way back', () => {
    expect([...readableTaskIds(plan, 'check')].sort()).toEqual(['build', 'check', 'fix', 'setup']);
  });

  it('reaches a loop\'s other end both ways: a check its body, and a body task its check', () => {
    expect(readableTaskIds(plan, 'check').has('fix')).toBe(true);
    expect([...readableTaskIds(plan, 'fix')].sort()).toEqual(['build', 'check', 'fix', 'setup']);
  });

  it('leaves out a task the graph never gave it, a subtask\'s own dependencies counted', () => {
    expect([...readableTaskIds(plan, 'docs')]).toEqual(['docs']);
    expect([...readableTaskIds(plan, 'build.1')].sort()).toEqual(['build.1', 'setup']);
  });
});

describe('a handoff as a surface words it', () => {
  it('labels a severity, and names the worst one a row can show', () => {
    expect(severityLabel('blocker')).toBe('Blocker');
    expect(severityLabel('info')).toBe('Info');
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity([{ severity: 'info' }, { severity: 'major' }, { severity: 'minor' }])).toBe('major');
    expect(worstSeverity([{ severity: 'minor' }, { severity: 'blocker' }, { severity: 'major' }])).toBe('blocker');
  });

  it('renders every reference kind as a reader would copy it', () => {
    expect(handoffReferenceText({ kind: 'file', path: 'src/a.ts', line: 3 })).toBe('src/a.ts:3 (unresolved)');
    expect(handoffReferenceText({ kind: 'file', path: 'src/a.ts' })).toBe('src/a.ts (unresolved)');
    expect(handoffReferenceText({ kind: 'commit', sha: 'abc123', repo: 'api' })).toBe('commit abc123 in api (unresolved)');
    expect(handoffReferenceText({ kind: 'task', task: 't2', finding: 'F1' }, (id) => (id === 't2' ? '#2' : undefined))).toBe('#2/F1');
    expect(handoffReferenceText({ kind: 'url', url: 'https://example.com/pr/1' })).toBe('https://example.com/pr/1');
  });
});

describe('a handoff a headless surface prints (ADR-0047)', () => {
  const handoff: HandoffDigest = {
    summary: 'The cache key omits the tenant.',
    findings: [
      { id: 'F1', severity: 'blocker', title: 'The cache key omits the tenant', detail: 'A second tenant reads the first one\'s entry.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 42 }] },
      { id: 'F2', severity: 'major', title: 'No regression test' },
    ],
    findingCount: 4,
    artifacts: [{ kind: 'file', path: 'src/cache.ts', line: 42 }, { kind: 'url', url: 'https://example.com/pr/7' }],
  };

  it('gives the summary, each finding\'s title line, the ones the digest left out and the artifacts', () => {
    expect(handoffPreviewLines(handoff)).toEqual([
      'The cache key omits the tenant.',
      'F1 [blocker] The cache key omits the tenant',
      'F2 [major] No regression test',
      '+2 more findings, in the attempt\'s log',
      'Artifacts: src/cache.ts:42 (unresolved); https://example.com/pr/7',
    ]);
  });

  it('puts the commit, subject then body, before the summary, and prints a commit-only handoff', () => {
    const commit = { subject: 'Scope the cache key', body: 'Adds the tenant.\nKeeps the TTL.' };
    expect(handoffPreviewLines({ ...handoff, commit }).slice(0, 4)).toEqual([
      'Commit: Scope the cache key', 'Adds the tenant.', 'Keeps the TTL.', 'The cache key omits the tenant.',
    ]);
    expect(handoffPreviewLines({ summary: '', findings: [], findingCount: 0, commit: { subject: 'Only this' } })).toEqual(['Commit: Only this']);
  });

  it('stops at a finding budget and counts the rest from the whole handoff', () => {
    expect(handoffPreviewLines(handoff, { maxFindings: 1 })).toEqual([
      'The cache key omits the tenant.',
      'F1 [blocker] The cache key omits the tenant',
      '+3 more findings, in the attempt\'s log',
      'Artifacts: src/cache.ts:42 (unresolved); https://example.com/pr/7',
    ]);
  });

  it('prints a saved patch as its own block, after the author\'s artifacts (ADR-0050)', () => {
    const patch: HandoffPatch = {
      kind: 'patch', path: '.ordewell/sessions/s1/tasks/t1/1.patch', attempt: 2,
      base: 'b'.repeat(40), files: 1, added: 3, removed: 0, binary: 0, bytes: 300, sha256: 'c'.repeat(64),
      flags: [{ kind: 'normalized', count: 1, paths: ['notes.txt'] }],
    };

    expect(handoffPreviewLines({ ...handoff, artifacts: [...handoff.artifacts!, patch] })).toEqual([
      'The cache key omits the tenant.',
      'F1 [blocker] The cache key omits the tenant',
      'F2 [major] No regression test',
      '+2 more findings, in the attempt\'s log',
      'Artifacts: src/cache.ts:42 (unresolved); https://example.com/pr/7',
      'Patch: 1 file, +3 -0, 300 B, from commit bbbbbbbbbbbb',
      'saved as .ordewell/sessions/s1/tasks/t1/1.patch (attempt 2)',
      'normalized by git attributes: 1 file (notes.txt)',
    ]);
  });

  it('gives a wake-up the top findings whole, detail and evidence included', () => {
    expect(handoffWakeLines(handoff).slice(0, 6)).toEqual([
      'The cache key omits the tenant.',
      '',
      'Findings:',
      '- F1 [blocker] The cache key omits the tenant',
      '  A second tenant reads the first one\'s entry.',
      '  Evidence: src/cache.ts:42 (unresolved)',
    ]);
    expect(handoffWakeLines(handoff)).toContain('+2 more findings; read with task_output.');
  });
});

describe('the commit a done call states', () => {
  const done = (body: string) => storedHandoff({ status: 'done', summary: '', commit: { subject: 'Add the check', body } })?.commit;

  it('drops attribution trailers wherever they stand, and keeps the prose around them', () => {
    expect(done([
      'Users ran stale builds for weeks.',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
      'The check runs once a day.',
      'Signed-off-by: A Dev <dev@example.com>',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n'))).toEqual({ subject: 'Add the check', body: 'Users ran stale builds for weeks.\nThe check runs once a day.' });
  });

  it('drops a closing paragraph of trailers, and keeps a line of prose that only looks like one', () => {
    expect(done('Why: the old check ran on every start.\n\nFixes: #12\nRefs: #9')).toEqual({ subject: 'Add the check', body: 'Why: the old check ran on every start.' });
  });

  it('keeps no body when only trailers were in it', () => {
    expect(done('Co-authored-by: Someone <a@b.c>\n')).toEqual({ subject: 'Add the check' });
  });
});

describe('a patch a read-only task saved (ADR-0050)', () => {
  const patch: HandoffPatch = {
    kind: 'patch', path: '.ordewell/sessions/s/tasks/t/2.patch', attempt: 2, base: '0123456789abcdef0123456789abcdef01234567',
    files: 3, added: 40, removed: 2, binary: 1, bytes: 5 * 1024 + 512, sha256: 'd'.repeat(64),
    flags: [{ kind: 'excluded', count: 1, paths: ['.claude'] }, { kind: 'dropped', count: 12, paths: ['big.bin (1.5 MB)'] }],
  };

  it('reads as one line: where, how much, from which commit, and what it does not carry', () => {
    expect(handoffReferenceText(patch)).toBe(
      'patch .ordewell/sessions/s/tasks/t/2.patch (attempt 2): 3 files, 1 binary, +40 -2, 5.5 KB, from commit 0123456789ab; '
      + 'not carried (links and submodules): 1 file (.claude); dropped over the size cap: 12 files (big.bin (1.5 MB), +11 more)',
    );
    expect(handoffReferenceText({ ...patch, files: 1, binary: 0, bytes: 900, flags: undefined })).toBe('patch .ordewell/sessions/s/tasks/t/2.patch (attempt 2): 1 file, +40 -2, 900 B, from commit 0123456789ab');
  });

  it("is added after the author's artifacts, or alone where the attempt left no handoff", () => {
    const authored = storedHandoff({ summary: 'Tried it.', artifacts: [{ kind: 'url', url: 'https://example.test' }] })!;
    expect(withPatch(authored, patch).artifacts).toEqual([{ kind: 'url', url: 'https://example.test' }, patch]);
    expect(withPatch(undefined, patch)).toEqual({ summary: '', findings: [], findingCount: 0, artifacts: [patch] });
    expect(savedPatchOf(withPatch(authored, patch))).toBe(patch);
    expect(savedPatchOf(authored)).toBeUndefined();
  });

  it('passes the completion check untouched: it is Ordewell\'s own record, not a reference to resolve', () => {
    const plan = [createTask({ id: 't', order: 1, title: 'T' })];
    expect(checkHandoff({ summary: '', artifacts: [patch] }, 't', plan)).toEqual({ ok: true, handoff: { summary: '', artifacts: [patch] } });
  });
});

describe('a reference pinned to its attempt (ADR-0057 R1)', () => {
  const finding = (title: string) => ({ severity: 'major' as const, title });
  const digest = (attempt: number | undefined, count: number): HandoffDigest => ({
    summary: 'Reviewed.',
    findings: Array.from({ length: count }, (_, i) => ({ id: `F${i + 1}`, ...finding(`finding ${i + 1}`) })),
    findingCount: count,
    ...(attempt === undefined ? {} : { attempt }),
  });
  const plan = (handoff?: HandoffDigest) => [
    createTask({ id: 'review', order: 4, title: 'Review', ...(handoff ? { handoff } : {}) }),
    createTask({ id: 'fix', order: 5, dependencies: ['review'] }),
  ];
  const cite = (task: string, more: { finding?: string } = {}) => ({ summary: 'Fixed.', artifacts: [{ kind: 'task' as const, task, ...more }] });
  const pinned = (check: ReturnType<typeof checkHandoff>) => {
    if (!check.ok) throw new Error(check.refusal);
    return check.handoff.artifacts;
  };

  it('stores the attempt the finding belongs to, under the root, from what authors write today', () => {
    expect(pinned(checkHandoff(cite('#4', { finding: 'F3' }), 'fix', plan(digest(2, 3))))).toEqual([{ kind: 'task', node: 'root', task: 'review', attempt: 2, finding: 'F3' }]);
  });

  it('reads the short form an author writes, #4/F3, as the same reference', () => {
    expect(pinned(checkHandoff(cite('#4/F3'), 'fix', plan(digest(2, 3))))).toEqual([{ kind: 'task', node: 'root', task: 'review', attempt: 2, finding: 'F3' }]);
  });

  it('pins a task named with no finding, whose handoff is what the reference points at', () => {
    expect(pinned(checkHandoff(cite('#4'), 'fix', plan(digest(2, 3))))).toEqual([{ kind: 'task', node: 'root', task: 'review', attempt: 2 }]);
  });

  it('leaves a title that only looks like a reference alone: the whole text is tried first', () => {
    const titled = [createTask({ id: 'odd', order: 1, title: 'Answer #4/F3' }), createTask({ id: 'fix', order: 2, dependencies: ['odd'] })];
    expect(pinned(checkHandoff(cite('Answer #4/F3'), 'fix', titled))).toEqual([{ kind: 'task', node: 'root', task: 'odd' }]);
  });

  it('refuses two different findings named at once', () => {
    const check = checkHandoff(cite('#4/F3', { finding: 'F2' }), 'fix', plan(digest(2, 3)));
    expect(check).toMatchObject({ ok: false, refusal: expect.stringContaining('F3 and F2') });
  });

  it('takes the attempt from the log for a digest saved before attempts were kept on it', () => {
    const logs = { attempts: () => [1, 2], handoff: () => undefined };
    expect(pinned(checkHandoff(cite('#4/F3'), 'fix', plan(digest(undefined, 3)), { logs }))).toEqual([{ kind: 'task', node: 'root', task: 'review', attempt: 2, finding: 'F3' }]);
  });

  it('stays unpinned where nothing says the attempt, and reads the latest as a saved one does', () => {
    expect(pinned(checkHandoff(cite('#4/F3'), 'fix', plan(digest(undefined, 3))))).toEqual([{ kind: 'task', node: 'root', task: 'review', finding: 'F3' }]);
  });

  it('checks an attempt the author names against that attempt, not the latest', () => {
    const logs = { attempts: () => [1, 2], handoff: (_: string, attempt: number) => (attempt === 1 ? digest(1, 5) : undefined) };
    expect(pinned(checkHandoff(cite('#4@1/F5'), 'fix', plan(digest(2, 1)), { logs }))).toEqual([{ kind: 'task', node: 'root', task: 'review', attempt: 1, finding: 'F5' }]);
    expect(checkHandoff(cite('#4@1/F6'), 'fix', plan(digest(2, 1)), { logs })).toMatchObject({ ok: false, refusal: expect.stringContaining('attempt 1 has F1 to F5') });
    expect(checkHandoff(cite('#4@3'), 'fix', plan(digest(2, 1)), { logs })).toMatchObject({ ok: false, refusal: expect.stringContaining('no saved attempt 3') });
  });

  it('pins a task naming itself to the attempt making the call', () => {
    const check = checkHandoff({ summary: 'Me.', artifacts: [{ kind: 'task', task: '#5' }] }, 'fix', plan(digest(2, 3)), { attempt: 3 });
    expect(pinned(check)).toEqual([{ kind: 'task', node: 'root', task: 'fix', attempt: 3 }]);
  });

  it('reads a task naming itself as the attempt making the call, not one an earlier attempt left on the plan', () => {
    const tasks = [createTask({ id: 'solo', order: 1, handoff: digest(1, 1) })];
    const check = checkHandoff({ summary: 'Again.', artifacts: [{ kind: 'task', task: '#1' }] }, 'solo', tasks, { attempt: 2 });
    expect(pinned(check)).toEqual([{ kind: 'task', node: 'root', task: 'solo', attempt: 2 }]);
  });

  it('renders as #4@2/F3, without the parts it does not have', () => {
    const name = (id: string) => (id === 'review' ? '#4' : undefined);
    expect(handoffReferenceText({ kind: 'task', node: 'root', task: 'review', attempt: 2, finding: 'F3' }, name)).toBe('#4@2/F3');
    expect(handoffReferenceText({ kind: 'task', node: 'root', task: 'review', attempt: 2 }, name)).toBe('#4@2');
  });

  it('reads a reference saved before pinning as the latest, with no migration', () => {
    const name = (id: string) => (id === 'review' ? '#4' : undefined);
    expect(handoffReferenceText({ kind: 'task', task: 'review', finding: 'F3' }, name)).toBe('#4/F3');
    expect(handoffReferenceText({ kind: 'task', task: 'review' }, name)).toBe('#4');
  });

  it('parses every form a reference is written in, and nothing else', () => {
    expect(parseFindingRef('#4@2/F3')).toEqual({ task: '#4', attempt: 2, finding: 'F3' });
    expect(parseFindingRef('#4.1/F3')).toEqual({ task: '#4.1', finding: 'F3' });
    expect(parseFindingRef('#4@2')).toEqual({ task: '#4', attempt: 2 });
    expect(parseFindingRef('#4')).toEqual({ task: '#4' });
    expect(parseFindingRef('Fix the auth/F3 thing')).toEqual({ task: 'Fix the auth/F3 thing' });
  });
});
