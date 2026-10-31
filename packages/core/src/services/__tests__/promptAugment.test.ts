import { describe, it, expect } from 'vitest';
import { createTask, resolveTaskRef, type Task, type TaskSkillSnapshot } from '../../models/Task';
import type { HandoffDigest, HandoffFinding } from '../../models/Handoff';
import { TASK_COMPLETION_CONTRACT, taskCompletionContract } from '../mcp';
import { augmentPromptWithPriorOutputs, composeAugmentedPrompt, composeContinuationPrompt, READ_ONLY_PATCH_NOTE, READ_ONLY_WEB_NOTE, renderPlanMap, summarizeOutput } from '../promptAugment';

describe('summarizeOutput', () => {
  it('clips output to last 500 chars', () => {
    const long = 'x'.repeat(5000) + 'TAIL';
    const s = summarizeOutput('ok', long);
    expect(s.logTail.length).toBeLessThanOrEqual(500);
    expect(s.logTail.endsWith('TAIL')).toBe(true);
  });

  it('trims whitespace from tail', () => {
    const s = summarizeOutput('reason', '   hello   \n  ');
    expect(s.logTail).toBe('hello');
  });

  it('defaults missing reviewReason to empty string', () => {
    const s = summarizeOutput(undefined, 'out');
    expect(s.reviewReason).toBe('');
  });

  it('keeps a report whole, and no tail beside it', () => {
    const report = 'Finding: '.padEnd(9000, 'y') + 'END';
    const s = summarizeOutput('Verified', report, report);
    expect(s.report).toBe(report);
    expect(s.logTail).toBe('');
  });

  it('cuts a report past 20000 characters, and says so in what it keeps', () => {
    const s = summarizeOutput('Verified', '', 'a'.repeat(20000) + 'q'.repeat(5000));
    expect(s.report!.startsWith('a'.repeat(20000) + '\n\n[Report cut by Ordewell at 20000 characters')).toBe(true);
    expect(s.report).not.toContain('q');
  });

  it('keeps the tail when there is no report', () => {
    const s = summarizeOutput('Failed verification', 'last words', undefined);
    expect(s).not.toHaveProperty('report');
    expect(s.logTail).toBe('last words');
  });
});

describe('prior outputs of a subtask dependency', () => {
  // "Task 1" names top-level task 1; a subtask is only ever its dotted label.
  it('heads the report with the dependency\'s dotted label, never its bare order', () => {
    const first = createTask({
      id: 'fn', order: 1, title: 'Add and export mul', prompt: 'add mul',
      outputSummary: { reviewReason: 'ok', report: 'Added mul to src/calc.js.', logTail: '', capturedAt: '2026-01-01T00:00:00Z' },
    });
    const second = createTask({ id: 'test', order: 2, title: 'Test mul', prompt: 'test mul', dependencies: ['fn'] });
    const parent = createTask({ id: 'mul', order: 1, title: 'Add mul', prompt: 'mul', subtasks: [first, second] });
    const other = createTask({ id: 'readme', order: 2, title: 'README check', prompt: 'readme' });

    const out = composeAugmentedPrompt(second, [parent, other], { planMapEnabled: false });

    expect(out).toContain('### Task 1.1: Add and export mul\n- Review: ok\n- Report:\n  Added mul to src/calc.js.');
    expect(out).not.toContain('### Task 1:');
  });
});

describe('prior outputs of a dependency with a handoff (ADR-0047)', () => {
  const review = (handoff: HandoffDigest, extra: Partial<Task> = {}) => createTask({
    id: 'rev', order: 1, title: 'Review auth', prompt: 'review', status: 'completed', handoff,
    outputSummary: { reviewReason: 'Verified', report: 'THE WHOLE HANDOFF AS ONE TEXT', logTail: '', capturedAt: 'x' },
    ...extra,
  });
  const fix = createTask({ id: 'fix', order: 2, title: 'Fix auth', prompt: 'fix it', dependencies: ['rev'] });

  it('gives the summary, then each finding whole with its id, severity, detail and evidence, then the artifacts', () => {
    const dep = review({
      summary: 'Two holes in the token flow; the rest is sound.',
      findings: [
        { id: 'F1', severity: 'blocker', title: 'Tokens never expire', detail: 'issue() sets no exp claim.\nrefresh() neither.', evidence: [{ kind: 'file', path: 'src/auth.ts', line: 42 }, { kind: 'commit', sha: 'a1b2c3d' }] },
        { id: 'F2', severity: 'major', title: 'No rate limit on login', evidence: [{ kind: 'url', url: 'https://owasp.org/rate-limits' }] },
        { id: 'F3', severity: 'info', title: 'The docs still describe v1' },
      ],
      findingCount: 3,
      artifacts: [{ kind: 'file', path: 'docs/auth-review.md' }, { kind: 'task', task: 'rev', finding: 'F1' }],
    });

    const out = composeAugmentedPrompt(fix, [dep, fix], { planMapEnabled: false });

    expect(out).toContain([
      '### Task 1: Review auth',
      '- Review: Verified',
      '- Handoff:',
      '  Two holes in the token flow; the rest is sound.',
      '',
      '  Findings:',
      '  - F1 [blocker] Tokens never expire',
      '    issue() sets no exp claim.',
      '    refresh() neither.',
      '    Evidence: src/auth.ts:42 (unresolved); commit a1b2c3d (unresolved)',
      '  - F2 [major] No rate limit on login',
      '    Evidence: https://owasp.org/rate-limits',
      '  - F3 [info] The docs still describe v1',
      '',
      '  Artifacts: docs/auth-review.md (unresolved); task #1 F1',
      '',
      'fix it',
    ].join('\n'));
    expect(out).not.toContain('THE WHOLE HANDOFF AS ONE TEXT');
    expect(out).not.toContain('more findings');
  });

  it('gives the commit subject, then its body, then the summary', () => {
    const dep = review({
      commit: { subject: 'Add a daily version check', body: 'Users ran stale builds for weeks.\nNobody told them.' },
      summary: 'The check is checkVersion() in core/src/version.ts.',
      findings: [],
      findingCount: 0,
    });

    const out = composeAugmentedPrompt(fix, [dep, fix], { planMapEnabled: false });

    expect(out).toContain([
      '- Handoff:',
      '  Commit: Add a daily version check',
      '  Users ran stale builds for weeks.',
      '  Nobody told them.',
      '',
      '  The check is checkVersion() in core/src/version.ts.',
      '',
      'fix it',
    ].join('\n'));
  });

  it('gives a handoff that is only a commit as that commit', () => {
    const dep = review({ commit: { subject: 'Add a daily version check' }, summary: '', findings: [], findingCount: 0 });

    const out = composeAugmentedPrompt(fix, [dep, fix], { planMapEnabled: false });

    expect(out).toContain(['- Handoff:', '  Commit: Add a daily version check', '', 'fix it'].join('\n'));
  });

  it('tells the dependent it can read any of them in full with read_task', () => {
    const dep = review({ summary: 'Done.', findings: [], findingCount: 0 });
    const out = composeAugmentedPrompt(fix, [dep, fix], { planMapEnabled: false });
    expect(out).toContain('## Prior task outputs\n\n`read_task` reads any of these tasks in full, every finding and its report, and the tasks they depend on too.\n\n### Task 1: Review auth');
  });

  it('keeps every finding whole: past 4000 characters it stops before the next one and counts the rest', () => {
    const findings = Array.from({ length: 12 }, (_, i): HandoffFinding => ({
      id: `F${i + 1}`, severity: 'major', title: `Finding ${String(i + 1).padStart(2, '0')}`, detail: `${i + 1}`.padEnd(600, '.'),
    }));
    const dep = review({ summary: 'Twelve findings.', findings, findingCount: 12 });

    const out = composeAugmentedPrompt(fix, [dep, fix], { planMapEnabled: false });

    // Each finding renders in about 630 characters, so six fit under 4000 and a seventh would not.
    for (let i = 1; i <= 6; i++) expect(out).toContain(`  - F${i} [major] Finding 0${i}\n    ${`${i}`.padEnd(600, '.')}\n`);
    expect(out).not.toContain('F7');
    expect(out).not.toContain('Finding 07');
    expect(out).toContain('  (+6 more findings; read task #1)\n\nfix it');
    expect(out).not.toContain('report cut here');
  });

  it('counts the findings the plan\'s digest left out, from its finding count', () => {
    const findings = Array.from({ length: 25 }, (_, i): HandoffFinding => ({ id: `F${i + 1}`, severity: 'minor', title: `Small ${i + 1}` }));
    const dep = review({ summary: 'Thirty findings.', findings, findingCount: 30 });

    const out = composeAugmentedPrompt(fix, [dep, fix], { planMapEnabled: false });

    expect(out).toContain('  - F25 [minor] Small 25\n  (+5 more findings; read task #1)');
  });

  it('points a subtask\'s reader at its dotted reference, and says one finding left out as one', () => {
    const findings: HandoffFinding[] = [
      { id: 'F1', severity: 'major', title: 'Big', detail: 'b'.repeat(2_000) },
      { id: 'F2', severity: 'major', title: 'Bigger', detail: 'c'.repeat(2_000) },
    ];
    const sub = createTask({ id: 'sub', order: 1, title: 'Review part', prompt: 'r', status: 'completed', handoff: { summary: 'Two.', findings, findingCount: 2 } });
    const after = createTask({ id: 'after', order: 2, title: 'Fix part', prompt: 'f', dependencies: ['sub'] });
    const parent = createTask({ id: 'p', order: 1, title: 'Part', prompt: 'p', subtasks: [sub, after] });

    const out = composeAugmentedPrompt(after, [parent], { planMapEnabled: false });

    expect(out).toContain('  - F1 [major] Big');
    expect(out).not.toContain('Bigger');
    expect(out).toContain('  (+1 more finding; read task #1.1)');
  });

  it('tells a loop\'s body task which of its check\'s findings to answer, and that the check runs again', () => {
    const findings = Array.from({ length: 3 }, (_, i): HandoffFinding => ({ id: `F${i + 1}`, severity: 'major', title: `Hole ${i + 1}` }));
    const check = createTask({
      id: 'rev', order: 1, title: 'Review auth', prompt: 'review', status: 'failed', loop: { body: ['fix'], maxRounds: 3 },
      verdict: { outcome: 'fail', reason: 'found problems', checks: [], decidedAt: 'x', reported: 'failed' },
      outputSummary: { reviewReason: 'The runner reported failed: three holes.', logTail: '', capturedAt: 'x' },
      handoff: { summary: 'Three holes.', findings, findingCount: 3 },
    });

    const out = composeAugmentedPrompt(fix, [check, fix], { planMapEnabled: false });

    expect(out).toContain([
      '### Task 1: Review auth',
      '- The check of your loop: it failed round 1 of 3, and you are part of the fix. Answer its findings F1 to F3. Fix what its report found; it runs again once the fix has landed.',
      '- Review: The runner reported failed: three holes.',
      '- Handoff:',
      '  Three holes.',
    ].join('\n'));
  });

  it('renders a dependency saved before handoffs from its output summary, as before', () => {
    const legacy = createTask({
      id: 'old', order: 1, title: 'Old review', prompt: 'r', status: 'completed',
      outputSummary: { reviewReason: 'Verified', report: 'k'.repeat(4000) + 'z'.repeat(10), logTail: '', capturedAt: 'x' },
    });
    const next = createTask({ id: 'next', order: 2, title: 'Next', prompt: 'n', dependencies: ['old'] });

    const out = composeAugmentedPrompt(next, [legacy, next], { planMapEnabled: false });

    expect(out).toContain(`## Prior task outputs\n\n### Task 1: Old review\n- Review: Verified\n- Report:\n  ${'k'.repeat(4000)}\n  (report cut here: 10 more characters)`);
    expect(out).not.toContain('read_task');
  });
});

describe('a check sees what changed since its last round (ADR-0047)', () => {
  it('puts its previous findings and the body claims before the map and existing dependencies', () => {
    const build = createTask({ id: 'build', order: 1, title: 'Build', handoff: { summary: 'Built it.', findings: [], findingCount: 0 } });
    const check = createTask({ id: 'check', order: 2, title: 'Review', prompt: 'Review the parser.', dependencies: ['build'], loop: { body: ['fix'], maxRounds: 3 } });
    const fix = createTask({ id: 'fix', order: 3, title: 'Fix', dependencies: ['check'], handoff: { summary: 'Fixed commas and escapes.', findings: [], findingCount: 0 } });

    const out = composeAugmentedPrompt(check, [build, check, fix], { loop: {
      round: 2,
      previousHandoff: { summary: 'Two holes.', findings: [
        { id: 'F1', severity: 'major', title: 'Trailing commas vanish' },
        { id: 'F2', severity: 'minor', title: 'Escapes are doubled' },
      ], findingCount: 2, report: 'Do not push the long report.' },
    } });

    expect(out).toContain('## Since your last round');
    expect(out).toContain('F1 [major] Trailing commas vanish');
    expect(out).toContain('F2 [minor] Escapes are doubled');
    expect(out).toContain('### Task 3: Fix\n- Handoff:\n  Fixed commas and escapes.');
    expect(out).toContain('You are the check, round 2 of 3. Verify the fix claims against the tree; do not trust its summary. Answer each previous finding by its F number: fixed, still open, or superseded. Report only what still fails and anything new.');
    expect(out.indexOf('## Since your last round')).toBeLessThan(out.indexOf('## Plan map'));
    expect(out).toContain('### Task 1: Build');
    expect(out.endsWith('Review the parser.')).toBe(true);
    expect(out).not.toContain('Do not push the long report.');
  });

  it('gives each body task the dependency budget and points omitted findings at that body task', () => {
    const check = createTask({ id: 'check', order: 1, prompt: 'Check.', loop: { body: ['fix', 'retest'], maxRounds: 3 } });
    const claim: HandoffDigest = { summary: 'c'.repeat(1000), findings: [
      { id: 'F1', severity: 'info', title: 'First claim', detail: 'a'.repeat(1800) },
      { id: 'F2', severity: 'info', title: 'Second claim', detail: 'b'.repeat(1800) },
    ], findingCount: 27 };
    const fix = createTask({ id: 'fix', order: 2, title: 'Fix', handoff: claim });
    const retest = createTask({ id: 'retest', order: 3, title: 'Retest', handoff: claim });

    const out = composeAugmentedPrompt(check, [check, fix, retest], { planMapEnabled: false, loop: { round: 2 } });

    expect(out.match(/F1 \[info\] First claim/g)).toHaveLength(2);
    expect(out.match(/a{1800}/g)).toHaveLength(2);
    expect(out).not.toContain('Second claim');
    expect(out).toContain('(+26 more findings; read task #2)');
    expect(out).toContain('(+26 more findings; read task #3)');
  });

  it('keeps the check\'s own legacy report whole when its findings are not structured', () => {
    const check = createTask({ id: 'check', prompt: 'Check.', loop: { body: ['fix'], maxRounds: 3 } });
    const report = 'A legacy finding.\n'.repeat(250) + 'Last finding: the escape is doubled.';

    const out = composeAugmentedPrompt(check, [check], { loop: { round: 2, previousReport: report } });

    expect(out).toContain(`Your previous findings are not structured.\n${report}`);
  });

  it('opens its previous handoff with the commit it stated, so a commit-only handoff is not blank', () => {
    const check = createTask({ id: 'check', order: 1, title: 'Review', prompt: 'Review.', loop: { body: ['fix'], maxRounds: 3 } });
    const fix = createTask({ id: 'fix', order: 2, title: 'Fix', dependencies: ['check'] });

    const out = composeAugmentedPrompt(check, [check, fix], { loop: {
      round: 2,
      previousHandoff: { commit: { subject: 'Tighten the parser', body: 'It accepted blank lines.' }, summary: '', findings: [], findingCount: 0, artifacts: [{ kind: 'file', path: 'src/parser.ts' }] },
    } });

    expect(out).toContain('### Your previous handoff\nCommit: Tighten the parser\nIt accepted blank lines.\nArtifacts: src/parser.ts (unresolved)\n');
  });

  it('omits the block for round 1 and for a script check', () => {
    const check = createTask({ id: 'check', prompt: 'Check.', loop: { body: ['fix'], maxRounds: 3 } });
    expect(composeAugmentedPrompt(check, [check], { loop: { round: 1 } })).not.toContain('## Since your last round');
    expect(composeAugmentedPrompt({ ...check, type: 'script', prompt: undefined }, [check], { loop: { round: 2 } })).not.toContain('## Since your last round');
  });
});

describe('augmentPromptWithPriorOutputs', () => {
  it('returns the original prompt when the task has no dependencies', () => {
    const t = createTask({ id: 'a', prompt: 'do A', dependencies: [] });
    expect(augmentPromptWithPriorOutputs(t, [t])).toBe('do A');
  });

  it('returns the original prompt when dependencies have no outputSummary yet', () => {
    const dep = createTask({ id: 'a', prompt: 'do A' });
    const cur = createTask({ id: 'b', prompt: 'do B', dependencies: ['a'] });
    expect(augmentPromptWithPriorOutputs(cur, [dep, cur])).toBe('do B');
  });

  it('prepends a block with the direct dependency outputs', () => {
    const dep = createTask({
      id: 'a', order: 1, title: 'Build auth', prompt: 'do A',
      outputSummary: { reviewReason: 'all green', logTail: 'created src/auth.ts', capturedAt: '2026-01-01T00:00:00Z' },
    });
    const cur = createTask({ id: 'b', order: 2, title: 'Wire auth', prompt: 'do B', dependencies: ['a'] });
    const out = augmentPromptWithPriorOutputs(cur, [dep, cur]);
    expect(out).toContain('## Prior task outputs');
    expect(out).toContain('### Task 1: Build auth');
    expect(out).toContain('Review: all green');
    expect(out).toContain('created src/auth.ts');
    expect(out.endsWith('do B')).toBe(true);
  });

  it('hands a dependent the report in place of the tail', () => {
    const dep = createTask({
      id: 'a', order: 1, title: 'Review auth', prompt: 'do A',
      outputSummary: { reviewReason: 'Verified', report: 'Findings:\n1. token never expires\n2. no rate limit', logTail: '', capturedAt: 'x' },
    });
    const cur = createTask({ id: 'b', order: 2, title: 'Fix auth', prompt: 'do B', dependencies: ['a'] });
    const out = augmentPromptWithPriorOutputs(cur, [dep, cur]);
    expect(out).toContain('- Report:\n  Findings:\n  1. token never expires\n  2. no rate limit');
    expect(out).not.toContain('Tail');
    expect(out).not.toContain('no output captured');
  });

  it('cuts a dependency report past 4000 characters for the prompt, and says so', () => {
    const dep = createTask({
      id: 'a', order: 1, title: 'Review', prompt: 'do A',
      outputSummary: { reviewReason: 'Verified', report: 'k'.repeat(4000) + 'z'.repeat(3000), logTail: '', capturedAt: 'x' },
    });
    const cur = createTask({ id: 'b', order: 2, title: 'Fix', prompt: 'do B', dependencies: ['a'] });
    const out = augmentPromptWithPriorOutputs(cur, [dep, cur]);
    expect(out).toContain('k'.repeat(4000));
    expect(out).not.toContain('z');
    expect(out).toContain('(report cut here: 3000 more characters)');
  });

  it('skips non-direct (transitive) dependencies', () => {
    const grand = createTask({
      id: 'a', order: 1, title: 'Grandparent', prompt: 'do A',
      outputSummary: { reviewReason: 'g-done', logTail: 'g-tail', capturedAt: 'x' },
    });
    const parent = createTask({
      id: 'b', order: 2, title: 'Parent', prompt: 'do B', dependencies: ['a'],
      outputSummary: { reviewReason: 'p-done', logTail: 'p-tail', capturedAt: 'x' },
    });
    const cur = createTask({ id: 'c', order: 3, title: 'Child', prompt: 'do C', dependencies: ['b'] });
    const out = augmentPromptWithPriorOutputs(cur, [grand, parent, cur]);
    expect(out).toContain('Parent');
    expect(out).toContain('p-tail');
    expect(out).not.toContain('Grandparent');
    expect(out).not.toContain('g-tail');
  });

  it('sorts dependency blocks by order', () => {
    const a = createTask({
      id: 'a', order: 2, title: 'Second', prompt: 'pa',
      outputSummary: { reviewReason: 'r-a', logTail: 't-a', capturedAt: 'x' },
    });
    const b = createTask({
      id: 'b', order: 1, title: 'First', prompt: 'pb',
      outputSummary: { reviewReason: 'r-b', logTail: 't-b', capturedAt: 'x' },
    });
    const cur = createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc', dependencies: ['a', 'b'] });
    const out = augmentPromptWithPriorOutputs(cur, [a, b, cur]);
    const idxFirst = out.indexOf('First');
    const idxSecond = out.indexOf('Second');
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxFirst).toBeLessThan(idxSecond);
  });
});

describe('renderPlanMap', () => {
  it('returns empty string for plans with fewer than 3 tasks', () => {
    const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'pa' });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });
    expect(renderPlanMap([a, b], 'a')).toBe('');
    expect(renderPlanMap([a], 'a')).toBe('');
  });

  it('marks the current task with NOW and an arrow', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'First', status: 'completed' }),
      createTask({ id: 'b', order: 2, title: 'Second' }),
      createTask({ id: 'c', order: 3, title: 'Third' }),
    ];
    const out = renderPlanMap(tasks, 'b');
    expect(out).toContain('[NOW');
    // exactly one task row is flagged as the current one
    expect(out.match(/\[NOW\s*\]/g) ?? []).toHaveLength(1);
    expect(out).toMatch(/\[NOW\s*\] Second.*← you are here/);
  });

  it('maps statuses correctly', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'Done one', status: 'completed' }),
      createTask({ id: 'b', order: 2, title: 'Failed one', status: 'failed' }),
      createTask({ id: 'd', order: 4, title: 'Manual one', type: 'user' }),
      createTask({ id: 'e', order: 5, title: 'Pending one' }),
      createTask({ id: 'f', order: 6, title: 'Running one', status: 'in_progress' }),
    ];
    const out = renderPlanMap(tasks, 'e');
    expect(out).toMatch(/\[done\s*\] Done one/);
    expect(out).toMatch(/\[failed\s*\] Failed one/);
    expect(out).toMatch(/\[user\s*\] Manual one/);
    expect(out).toMatch(/\[NOW\s*\] Pending one/);
    expect(out).toMatch(/\[running\] Running one/);
  });

  it('includes the scope guardrail', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A' }),
      createTask({ id: 'b', order: 2, title: 'B' }),
      createTask({ id: 'c', order: 3, title: 'C' }),
    ];
    const out = renderPlanMap(tasks, 'a');
    expect(out).toContain('do ONLY the task marked');
    expect(out).toContain('Future tasks will handle their own scope');
  });

  it('sorts by order regardless of array order', () => {
    const tasks = [
      createTask({ id: 'c', order: 3, title: 'C' }),
      createTask({ id: 'a', order: 1, title: 'A' }),
      createTask({ id: 'b', order: 2, title: 'B' }),
    ];
    const out = renderPlanMap(tasks, 'b');
    const ia = out.indexOf('A');
    const ib = out.indexOf('B');
    const ic = out.indexOf('C');
    expect(ia).toBeLessThan(ib);
    expect(ib).toBeLessThan(ic);
  });

  it('windows around the current task when over maxEntries', () => {
    const tasks = Array.from({ length: 50 }, (_, i) =>
      createTask({ id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}`, status: i < 30 ? 'completed' : 'pending' })
    );
    const out = renderPlanMap(tasks, 't35', { maxEntries: 10 });
    expect(out).toContain('Task 35');
    expect(out).toContain('omitted from this view');
    // Should NOT include Task 1 (way before the window) or Task 50 (way after a 10-wide window biased on 35)
    expect(out).not.toMatch(/Task 1\b/);
  });

  it('shifts the window left when current is near the end', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      createTask({ id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}` })
    );
    const out = renderPlanMap(tasks, 't20', { maxEntries: 5 });
    // window of 5 ending at task 20 should include 16-20
    expect(out).toContain('Task 20');
    expect(out).toContain('Task 16');
    expect(out).not.toContain('Task 15');
  });

  it('renders subtasks indented under their parent with dotted labels', () => {
    const parent = createTask({
      id: 'p1', order: 2, title: 'Parent',
      subtasks: [
        createTask({ id: 's1', order: 1, title: 'Sub one' }),
        createTask({ id: 's2', order: 2, title: 'Sub two' }),
      ],
    });
    const solo = createTask({ id: 'a', order: 1, title: 'Solo' });
    const out = renderPlanMap([solo, parent], 'p1');
    expect(out).toContain(' 1. [next   ] Solo');
    expect(out).toContain(' 2. [NOW    ] Parent');
    expect(out).toContain('2.1. [next   ] Sub one');
    expect(out).toContain('2.2. [next   ] Sub two');
    // Subtask rows step in two spaces under the parent's line.
    const subLine = out.split('\n').find((l) => l.includes('Sub one'))!;
    const parentLine = out.split('\n').find((l) => l.includes('Parent'))!;
    expect(subLine.indexOf('Sub one')).toBeGreaterThan(parentLine.indexOf('Parent'));
  });

  it('labels a current subtask with its dotted label, matching resolveTaskId', () => {
    const parent = createTask({
      id: 'p1', order: 2, title: 'Parent',
      subtasks: [createTask({ id: 's1', order: 1, title: 'Sub one' })],
    });
    const solo = createTask({ id: 'a', order: 1, title: 'Solo' });
    const out = renderPlanMap([solo, parent], 's1');
    expect(out).toMatch(/2\.1\. \[NOW\s*\] Sub one.*← you are here/);
    expect(resolveTaskRef([solo, parent], '2.1')?.id).toBe('s1');
  });
});

describe('renderPlanMap runners', () => {
  it('names the runner of an AI task only, not of a script or a manual one', () => {
    const ai = createTask({ id: 'a', order: 1, title: 'Build', assignedRunner: 'codex' });
    const man = createTask({ id: 'm', order: 2, title: 'Review by hand', type: 'user', assignedRunner: 'codex' });
    const script = createTask({ id: 's', order: 3, title: 'Push', type: 'script', assignedRunner: 'codex', commands: [['git', 'push']] });
    const out = renderPlanMap([ai, man, script], 'a');
    expect(out).toContain('Build (codex)');
    expect(out).toMatch(/Review by hand(?! \()/);
    expect(out).not.toContain('Review by hand (codex)');
    expect(out).toContain('Push (script)');
  });
});

describe('composeAugmentedPrompt', () => {
  it('emits plan map + prior outputs + base prompt in order', () => {
    const a = createTask({
      id: 'a', order: 1, title: 'Build', prompt: 'pa', status: 'completed',
      outputSummary: { reviewReason: 'ok', logTail: 'tail-A', capturedAt: 'x' },
    });
    const b = createTask({
      id: 'b', order: 2, title: 'Wire', prompt: 'do B', dependencies: ['a'],
    });
    const c = createTask({ id: 'c', order: 3, title: 'Test', prompt: 'pc' });
    const out = composeAugmentedPrompt(b, [a, b, c]);
    const iMap = out.indexOf('## Plan map');
    const iPrior = out.indexOf('## Prior task outputs');
    const iPrompt = out.indexOf('do B');
    expect(iMap).toBeGreaterThanOrEqual(0);
    expect(iPrior).toBeGreaterThan(iMap);
    expect(iPrompt).toBeGreaterThan(iPrior);
  });

  it('omits the plan map when planMapEnabled is false', () => {
    const a = createTask({
      id: 'a', order: 1, title: 'A', prompt: 'pa',
      outputSummary: { reviewReason: 'r', logTail: 't', capturedAt: 'x' },
    });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'do B', dependencies: ['a'] });
    const c = createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' });
    const out = composeAugmentedPrompt(b, [a, b, c], { planMapEnabled: false });
    expect(out).not.toContain('## Plan map');
    expect(out).toContain('## Prior task outputs');
  });

  it('returns the base prompt verbatim when there are no augmentations to add', () => {
    const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'solo' });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });
    // <3 tasks → no plan map. No deps → no prior outputs.
    const out = composeAugmentedPrompt(a, [a, b]);
    expect(out).toBe('solo');
  });

  // The runner summarises its first message when it compacts; its instructions it re-applies whole.
  it('leaves how to end to the runner\'s instructions, and teaches no text marker', () => {
    const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });
    const c = createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' });

    const out = composeAugmentedPrompt(c, [a, b, c]);
    expect(out).not.toContain('task_complete');
    expect(out).not.toContain('ORDEWELL');
    expect(out).not.toContain('marker');
    expect(TASK_COMPLETION_CONTRACT).toContain('call the `task_complete` tool with status `done`');
    expect(TASK_COMPLETION_CONTRACT).toContain('`blocked` or `failed`');
    expect(TASK_COMPLETION_CONTRACT).not.toContain('ORDEWELL');
    expect(TASK_COMPLETION_CONTRACT).not.toContain('marker');
  });

  it('teaches the handoff: the summary for the next task, findings to act on with their evidence, the report read on demand and never a file (ADR-0047)', () => {
    const out = TASK_COMPLETION_CONTRACT;
    expect(out).toContain('Call it once, as your last action.');
    expect(out).toContain('`summary` is this task\'s handoff to the next task');
    expect(out).toContain('the planner and the tasks that depend on this one');
    expect(out).toMatch(/`findings`.*most important first/);
    expect(out).toMatch(/a file \(and line\), a commit, a task \(and one of its findings, as "F3"\) or a URL/);
    expect(out).toMatch(/`report`.*read only on demand/);
    expect(out).toMatch(/read-only task/);
    expect(out).toMatch(/do not write the report to a file/);
  });

  it('asks only a change task for its commit, and moves what changed and why out of its summary (ADR-0047)', () => {
    const change = taskCompletionContract({ commits: true });

    expect(taskCompletionContract({})).toBe(TASK_COMPLETION_CONTRACT);
    expect(TASK_COMPLETION_CONTRACT).not.toContain('`commit`');
    expect(change.startsWith(TASK_COMPLETION_CONTRACT)).toBe(true);
    expect(change).toMatch(/`commit`.*at most 100 characters and best 72 or fewer.*imperative mood/);
    expect(change).toMatch(/tells a human reviewer what changed and why/);
    expect(change).toMatch(/summary no longer repeats that/);
    expect(change).toMatch(/paths, symbols, decisions.*`artifacts`.*what is left and what to watch/);
    expect(change).toMatch(/summary may be empty/);
  });

  it('leaves a continued task\'s report rule to the instructions its resumed session is started with', () => {
    const out = composeContinuationPrompt(createTask({ id: 'a', prompt: 'review it' }), 'Look again');
    expect(out).not.toContain('task_complete');
  });
  const TDD: TaskSkillSnapshot = { name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md', content: 'RED then GREEN.\n' };

  it('puts each attached skill body in the prompt, framed with its name', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const deploy: TaskSkillSnapshot = { name: 'deploy', source: 'workspace', path: '/wt/.ordewell/skills/deploy/SKILL.md', content: 'Check the pipeline.' };
    const out = composeAugmentedPrompt(tasks[0], tasks, { skills: [TDD, deploy] });
    expect(out).toContain('## Task skills');
    expect(out).toContain('### Skill: tdd\n\nRED then GREEN.\n\n### Skill: deploy\n\nCheck the pipeline.');
    expect(out.indexOf('## Task skills')).toBeLessThan(out.indexOf('do work'));
  });

  it('says nothing about skills when the task has none', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    expect(composeAugmentedPrompt(tasks[0], tasks)).not.toContain('## Task skills');
    expect(composeAugmentedPrompt(tasks[0], tasks, { skills: [] })).not.toContain('## Task skills');
  });

  // The prompt is the only place a read-only task learns its worktree's prototype can be kept (ADR-0050).
  it('tells a read-only task, and no other, that save_patch keeps its prototype', () => {
    const tasks = [createTask({ id: 'a', order: 1, title: 'A', prompt: 'try it' })];
    expect(composeAugmentedPrompt(tasks[0], tasks, { readOnly: true })).toContain(READ_ONLY_PATCH_NOTE);
    expect(READ_ONLY_PATCH_NOTE).toMatch(/keep it with the `save_patch` tool before you finish: a later task can then apply it/);
    expect(composeAugmentedPrompt(tasks[0], tasks)).not.toContain('save_patch');
  });

  // Its runner's own web tools are refused, so the prompt names the route that is not (ADR-0046).
  it('tells a read-only task, and no other, to read the web with fetch and web_search, and what a refusal asks of it', () => {
    const tasks = [createTask({ id: 'a', order: 1, title: 'A', prompt: 'look it up' })];
    expect(composeAugmentedPrompt(tasks[0], tasks, { readOnly: true })).toContain(READ_ONLY_WEB_NOTE);
    expect(READ_ONLY_WEB_NOTE).toBe('Read the web with the `fetch` and `web_search` tools: your runner\'s own web tools are off on this task, and these work whether or not your commands run sealed. Nobody is asked: a read the user\'s web-read settings do not already allow is refused, saying why. Do not retry a refusal; report what you could not read in your handoff.');
    expect(composeAugmentedPrompt(tasks[0], tasks)).not.toContain('web_search');
  });

  it('includes checkpoint instructions for HITL tasks (autonomy=HITL)', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', autonomy: 'HITL' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks);
    expect(out).toContain('## Human-in-the-loop checkpoints');
    expect(out).toContain('Call the `checkpoint` tool');
    expect(out).toContain('`continue`');
    expect(out).toContain('`rejected:`');
    expect(out).not.toContain('ORDEWELL');
  });

  it('includes checkpoint instructions for HITL tasks (sliceType=HITL)', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', sliceType: 'HITL' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks);
    expect(out).toContain('## Human-in-the-loop checkpoints');
  });

  it('omits checkpoint instructions for AFK tasks', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', autonomy: 'AFK' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks);
    expect(out).not.toContain('## Human-in-the-loop checkpoints');
  });

  it('omits checkpoint instructions for tasks without autonomy or sliceType', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks);
    expect(out).not.toContain('## Human-in-the-loop checkpoints');
  });

  it('includes both skills and checkpoint instructions when applicable', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', autonomy: 'HITL' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks, { skills: [TDD] });
    expect(out).toContain('## Task skills');
    expect(out).toContain('## Human-in-the-loop checkpoints');
    const tddIdx = out.indexOf('## Task skills');
    const hitlIdx = out.indexOf('## Human-in-the-loop checkpoints');
    expect(tddIdx).toBeGreaterThan(0);
    expect(hitlIdx).toBeGreaterThan(tddIdx);
    // Both before the base prompt
    expect(out.indexOf('do work')).toBeGreaterThan(hitlIdx);
  });
});

describe('composeContinuationPrompt (ADR-0018, K1)', () => {
  const task = createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'ORIGINAL PROMPT BODY' });

  it('leads with the user\'s message and the protocol reminder', () => {
    const prompt = composeContinuationPrompt(task, '  also handle arrays \n');

    expect(prompt.startsWith('also handle arrays\n')).toBe(true);
    expect(prompt).toContain('continuing this task in the same session');
    expect(prompt).toContain('Check the working tree');
    expect(prompt).not.toContain('task_complete');
    expect(prompt).not.toContain('ORDEWELL');
  });
  it('does not resend the original prompt, the plan map or the prior outputs the session already holds', () => {
    const dep = createTask({ id: 't0', order: 0, title: 'Setup', status: 'completed', outputSummary: { reviewReason: 'ok', logTail: 'SETUP OUTPUT', capturedAt: '' } });
    const prompt = composeContinuationPrompt({ ...task, dependencies: ['t0'] }, 'go on');

    expect(prompt).not.toContain('ORIGINAL PROMPT BODY');
    expect(prompt).not.toContain('SETUP OUTPUT');
    expect(prompt).not.toContain(dep.title);
  });

  it('tells a continued ops task it is in the same checkout, and that its effects were not undone (ADR-0020)', () => {
    const prompt = composeContinuationPrompt({ ...task, ops: true }, 'go on', { ops: true });

    expect(prompt).toContain('in the same checkout');
    expect(prompt).toContain('check what already exists before acting again');
    expect(prompt).not.toContain('recreated from the integration branch');
  });

  it('reminds a HITL task of the checkpoint tool', () => {
    const plain = composeContinuationPrompt(task, 'go on');
    const hitl = composeContinuationPrompt({ ...task, autonomy: 'HITL' }, 'go on');

    expect(plain).not.toContain('`checkpoint` tool');
    expect(hitl).toContain('call the `checkpoint` tool: its result is `continue` or `rejected: <why>`');
    expect(hitl).not.toContain('ORDEWELL');
  });
});

describe('composeAugmentedPrompt — an ops task\'s previous attempt (ADR-0020)', () => {
  const task = createTask({ id: 'o1', order: 1, title: 'Deploy', prompt: 'deploy it', ops: true });

  it('carries the last attempt\'s output and asks to check what exists before acting', () => {
    const prompt = composeAugmentedPrompt(task, [task], { previousAttempt: 'created rg-dev\n' });

    expect(prompt).toContain('## Previous attempt');
    expect(prompt).toContain('check what already exists');
    expect(prompt).toContain('  created rg-dev');
  });

  it('says so when the last attempt printed nothing, and adds nothing on a first attempt', () => {
    expect(composeAugmentedPrompt(task, [task], { previousAttempt: '  ' })).toContain('(no output captured)');
    expect(composeAugmentedPrompt(task, [task], {})).not.toContain('## Previous attempt');
  });
});

it('reserves space for the omission pointer inside the dependency ceiling', () => {
  const producer = createTask({ id: 'a', order: 1, handoff: {
    summary: 's'.repeat(1500),
    findings: [
      { id: 'F1', severity: 'major', title: 't'.repeat(200), detail: 'd'.repeat(2000), evidence: [{ kind: 'file', path: 'p'.repeat(246) }] },
      { id: 'F2', severity: 'minor', title: 'Another' },
    ], findingCount: 2,
  } });
  const output = augmentPromptWithPriorOutputs(createTask({ id: 'b', dependencies: ['a'] }), [producer]);
  const payload = output.split('- Handoff:\n')[1].trimEnd().split('\n').map((l) => l.startsWith('  ') ? l.slice(2) : l).join('\n');
  expect(payload.length).toBeLessThanOrEqual(4000);
  expect(payload).toContain('+2 more findings; read task #1');
  expect(payload).not.toContain('- F1');
});
