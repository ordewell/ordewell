import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '../Task';
import {
  HANDOFF_PUSH_CHARS, checkHandoff, handoffDigest, handoffLines, handoffPreviewLines, handoffReferenceText, handoffWakeLines, namedHandoff, parsePlanPath, storedHandoff,
  type BelowPlan, type HandoffDigest, type HandoffFinding, type HandoffLogs, type HandoffPins, type SubtreeReport,
} from '../Handoff';

/** A handoff that crosses a level (ADR-0057 R1, R2). */

const task = (id: string, order: number, over: Partial<Task> = {}) => createTask({ id, order, title: id, ...over });
const finding = (id: string, severity: HandoffFinding['severity'], title: string, detail?: string): HandoffFinding => ({ id, severity, title, ...(detail ? { detail } : {}) });
const held = (attempt: number, ...findings: HandoffFinding[]): HandoffDigest => ({ summary: 's', findings, findingCount: findings.length, attempt });
const logsOf = (saved: Record<string, Record<number, HandoffDigest>>): HandoffLogs => ({
  attempts: (id) => Object.keys(saved[id] ?? {}).map(Number),
  handoff: (id, attempt) => saved[id]?.[attempt],
});

describe('a plan path in a written reference', () => {
  it('is what comes before the separator, which a task label cannot hold', () => {
    expect(parsePlanPath('3/2:#4@2/F3')).toEqual({ path: '3/2', rest: '#4@2/F3' });
    expect(parsePlanPath('2:#4/F3')).toEqual({ path: '2', rest: '#4/F3' });
    expect(parsePlanPath('#4/F3')).toBeUndefined();
    expect(parsePlanPath('Fix: the login')).toBeUndefined();
  });
});

describe('a subplanner\'s references (R1)', () => {
  const child = [task('t1', 1, { handoff: held(1, finding('F1', 'major', 'One')) }), task('t2', 2, { handoff: held(2, finding('F1', 'minor', 'Two'), finding('F2', 'minor', 'Three')) })];
  const logs = logsOf({ t1: { 1: child[0].handoff! }, t2: { 1: held(1), 2: child[1].handoff! } });
  const pins: HandoffPins = { logs, node: 'root/3', readable: new Set(['t1', 't2']), crossing: true };
  const evidence = (written: string) => ({ summary: 's', findings: [{ severity: 'info' as const, title: 't', evidence: [{ kind: 'task' as const, task: written }] }] });
  const pinned = (written: string, more: HandoffPins = {}) => {
    const checked = checkHandoff(evidence(written), 'delegated-in-the-parent', child, { ...pins, ...more });
    return checked.ok ? checked.handoff.findings?.[0].evidence?.[0] : checked.refusal;
  };

  it('resolve in its own plan, whatever the parent\'s plan holds, under its own node', () => {
    expect(pinned('#2/F2')).toEqual({ kind: 'task', node: 'root/3', task: 't2', attempt: 2, finding: 'F2', label: '#2' });
  });

  it('read any task of that plan: the graph of a task in no plan cannot give the set', () => {
    expect(pinned('#1')).toMatchObject({ task: 't1', attempt: 1 });
    expect(pinned('#2@1')).toMatchObject({ task: 't2', attempt: 1 });
  });

  it('refuse by the child plan\'s task', () => {
    expect(pinned('#2/F9')).toContain('"F9" is not a finding of #2 t2');
    expect(pinned('#7/F1')).toContain('"#7/F1" names no task in the plan');
  });

  it('reach a plan below by its path, pinned under its node and named as that plan names it', () => {
    const lower: BelowPlan = { node: 'root/3/2', tasks: [task('x', 4, { handoff: held(1, finding('F1', 'blocker', 'Deep')) })], logs: logsOf({ x: { 1: held(1, finding('F1', 'blocker', 'Deep')) } }) };
    const below = (path: string) => (path === '2' ? lower : undefined);
    expect(pinned('2:#4/F1', { below })).toEqual({ kind: 'task', node: 'root/3/2', task: 'x', attempt: 1, finding: 'F1', label: '#4' });
    expect(pinned('2:#4/F7', { below })).toContain('"F7" is not a finding of #4 x');
    expect(pinned('9:#4/F1', { below })).toContain('"9:#4/F1" names no plan below this one');
  });

  it('leave a task a title that reads like a path', () => {
    const titled = [task('t', 1, { title: '2:#4' })];
    const checked = checkHandoff(evidence('2:#4'), 'p', titled, { readable: new Set(['t']), below: () => undefined, node: 'root/3' });
    expect(checked.ok && checked.handoff.findings?.[0].evidence?.[0]).toMatchObject({ task: 't' });
  });
});

describe('a reference that has crossed a level', () => {
  const crossed = { kind: 'task', node: 'root/3/2', task: 'x', attempt: 2, finding: 'F3', label: '#4' } as const;

  it('renders with its path, and no plan names it, though an id may repeat between plans', () => {
    expect(handoffReferenceText(crossed)).toBe('3/2:#4@2/F3');
    expect(handoffReferenceText(crossed, () => '#1')).toBe('3/2:#4@2/F3');
    const digest = { summary: 's', findings: [{ ...finding('F1', 'info', 't'), evidence: [crossed] }], findingCount: 1 };
    expect(namedHandoff([task('x', 1)], digest).findings[0].evidence).toEqual([crossed]);
  });
});

describe('a report (R2)', () => {
  const item = (node: string, label: string, attempt: number, f: HandoffFinding) => ({ ref: { kind: 'task' as const, node, task: label, attempt, finding: f.id, label }, finding: f });
  const report = (over: Partial<SubtreeReport> = {}): SubtreeReport => ({
    node: 'root/1',
    counts: { done: 3, failed: 1, blocked: 0, skipped: 1, commits: 2, tokens: 1200 },
    findings: { blocker: 1, major: 2, minor: 0, info: 0 },
    open: [],
    promoted: [],
    ...over,
  });
  const digest = (subtree: SubtreeReport, own: HandoffFinding[] = []): HandoffDigest => ({ summary: 'It is done.', commit: { subject: 'Do it' }, findings: own, findingCount: own.length, subtree });
  const wake = (handoff: HandoffDigest) => handoffWakeLines(handoff);

  it('leads with counts Ordewell derived, then the commit and summary, then what is open, promoted and its own, in that order', () => {
    const lines = wake(digest(report({
      open: [item('root/1', '#2', 1, finding('F1', 'major', 'Which schema?'))],
      promoted: [item('root/1/1', '#4', 2, finding('F3', 'blocker', 'A race', 'It loses a write.'))],
    }), [finding('F1', 'info', 'My own note')]));
    expect(lines).toEqual([
      'Subtree: 3 done, 1 failed, 0 blocked, 1 skipped; 2 commits; 1200 tokens.',
      'Findings below: 1 blocker (1 shown), 2 major (1 shown).',
      '  Commit: Do it',
      '',
      '  It is done.',
      '',
      'Open, for you to decide (each in its author\'s words):',
      '- 1:#2@1/F1 [major] Which schema?',
      '',
      'Promoted (each in its author\'s words):',
      '- 1/1:#4@2/F3 [blocker] A race',
      '  It loses a write.',
      '',
      'Findings:',
      '- F1 [info] My own note',
      '',
      'The report, if the task wrote one, is in the attempt\'s log: read it with task_output.',
    ]);
  });

  it('names a finding as an item whole or not at all, and counts what the ceiling cut, promoted items included', () => {
    const long = 'x'.repeat(1_500);
    const promoted = [1, 2, 3, 4].map((n) => item('root/1', `#${n}`, 1, finding(`F${n}`, 'major', `Finding ${n}`, long)));
    const text = wake(digest(report({ promoted }), [finding('F1', 'info', 'Mine', long)])).join('\n');
    expect(text).toContain('Finding 2');
    expect(text).not.toContain('Finding 3');
    expect(text).not.toContain('Mine');
    expect(text).toContain('+3 more');
    expect(text).toContain('2 major (2 shown)');
    expect(text.length).toBeLessThanOrEqual(HANDOFF_PUSH_CHARS);
  });

  it('is one size at every level, however many tasks its subtree holds', () => {
    const many = Array.from({ length: 8 }, (_, n) => item('root/1/1/1', `#${n + 1}`, 1, finding(`F${n + 1}`, 'major', 'y'.repeat(200), 'z'.repeat(2_000))));
    const size = (promoted: typeof many) => wake(digest(report({ promoted, counts: { done: 9_999, failed: 9_999, blocked: 9_999, skipped: 9_999, commits: 9_999, tokens: 999_999_999 } }))).join('\n').length;
    expect(size(many)).toBeLessThanOrEqual(HANDOFF_PUSH_CHARS);
  });

  it('puts paths its branch changed outside its scope in what is open, from code', () => {
    const paths = Array.from({ length: 25 }, (_, n) => `src/${n}.ts`);
    const text = wake(digest(report({ outsideScope: { paths: paths.slice(0, 20), count: 25 } }))).join('\n');
    expect(text).toContain('- Changed outside its scope (from Ordewell): src/0.ts, ');
    expect(text).toContain('+5 more');
  });

  it('moves a subplanner\'s own finding it left open out of its findings, and counts it once', () => {
    const own = [finding('F1', 'major', 'Decide this'), finding('F2', 'info', 'A note')];
    const lines = wake(digest(report({ open: [{ finding: own[0] }] }), own));
    expect(lines.filter((line) => line.includes('Decide this'))).toEqual(['- F1 [major] Decide this']);
    expect(lines.indexOf('- F1 [major] Decide this')).toBeLessThan(lines.indexOf('- F2 [info] A note'));
    expect(lines.join('\n')).not.toContain('more');
  });

  it('says when nothing below raised anything', () => {
    expect(wake(digest(report({ findings: { blocker: 0, major: 0, minor: 0, info: 0 } })))[1]).toBe('Findings below: none.');
  });

  it('survives into the digest and the stored handoff, and a report of none leaves a flat handoff as it was', () => {
    const subtree = report();
    const stored = storedHandoff({ status: 'done', summary: 's', subtree })!;
    expect(stored.subtree).toEqual(subtree);
    expect(handoffDigest(stored).subtree).toEqual(subtree);
    const flat = storedHandoff({ status: 'done', summary: 's' })!;
    expect(flat).not.toHaveProperty('subtree');
    expect(handoffDigest(flat)).not.toHaveProperty('subtree');
  });

  it('reads whole in the long form and leads a compact surface with its counts', () => {
    const subtree = report({ promoted: [item('root/1', '#2', 1, finding('F1', 'major', 'A thing'))] });
    expect(handoffLines(digest(subtree))).toEqual(expect.arrayContaining(['Subtree: 3 done, 1 failed, 0 blocked, 1 skipped; 2 commits; 1200 tokens.', '- 1:#2@1/F1 [major] A thing']));
    expect(handoffPreviewLines(digest(subtree))[0]).toBe('Subtree: 3 done, 1 failed, 0 blocked, 1 skipped; 2 commits; 1200 tokens.');
  });
});

describe('a handoff citing many tasks', () => {
  it('walks the plan once to name them all', () => {
    let reads = 0;
    const plan = Array.from({ length: 200 }, (_, i) => new Proxy(task(`t${i}`, i + 1), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    }));
    const cited = plan.map((_, i) => ({ kind: 'task' as const, task: `t${i}` }));

    const named = namedHandoff(plan, held(1, { ...finding('F1', 'info', 'Cited'), evidence: cited }));

    expect(named.findings[0].evidence?.at(-1)).toEqual({ kind: 'task', task: '#200' });
    expect(reads).toBeLessThan(200 * 10);
  });
});
