import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_TASK_LOG_FOLLOW, replayTaskLog, type HandoffPatch, type StoredHandoff, type TaskLogEvent } from '@ordewell/core';
import { stripAnsi, style, width } from '../ansi';
import { footerHints } from '../layout';
import { reduce } from '../reducer';
import { render } from '../render';
import { initialState, type TaskLogState, type TaskView, type TuiState } from '../state';

/*
 * A task's handoff (ADR-0047) on this surface: its expanded plan detail and
 * the block its task view draws, report folded until ctrl+o.
 */

beforeAll(() => {
  style.enabled = false;
});

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'completed', dependencies: [], ...over,
});

const handoff: StoredHandoff = {
  summary: 'Added the route.',
  findings: [
    {
      id: 'F1', severity: 'blocker', title: 'Missing auth', detail: 'Add a guard.',
      evidence: [{ kind: 'file', path: 'src/route.ts', line: 12 }, { kind: 'commit', sha: 'abc123' }],
    },
    { id: 'F2', severity: 'minor', title: 'Rename x', evidence: [{ kind: 'url', url: 'https://example.com/pr/1' }] },
  ],
  findingCount: 2,
  artifacts: [{ kind: 'file', path: 'src/route.ts' }],
  report: Array.from({ length: 14 }, (_, i) => `report line ${i + 1}`).join('\n'),
};

const log = (events: TaskLogEvent[]): TaskLogState => ({
  taskId: 't1',
  ...EMPTY_TASK_LOG_FOLLOW,
  view: replayTaskLog(events),
  attempts: [1],
  attempt: 1,
  loaded: true,
  followLatest: true,
  queuedIndex: null,
});

const opened = (events: TaskLogEvent[], over: Partial<TuiState> = {}): TuiState => initialState({
  sessionId: 's1', rows: 50, cols: 100, focus: 'chat', tasks: [task()], taskView: log(events), ...over,
});

const plain = (state: TuiState): string => render(state).map(stripAnsi).join('\n');
/** The plan pane with its row wrapping joined, so a line is asserted as the sentence it is. */
const planText = (state: TuiState): string => render(state).map(stripAnsi)
  .map((line) => (line.includes('│') ? line.slice(line.indexOf('│') + 1) : line))
  .join(' ').replace(/\s+/g, ' ');
const pressed = (state: TuiState, name: string): TuiState => reduce(state, { type: 'key', key: { name } }).state;

describe('a task\'s handoff in its row (ADR-0047)', () => {
  it('keeps the summary and its finding count and severity out of a collapsed task', () => {
    const state = initialState({ rows: 24, cols: 100, focus: 'plan', tasks: [task({ handoff: { ...handoff, summary: 'OK' } })] });
    expect(planText(state)).not.toContain('OK');
    expect(planText({ ...state, expandedTaskId: 't1' })).toContain('2 findings · Blocker · OK');
  });

  it('starts the summary at its first line with words', () => {
    const state = initialState({ rows: 24, cols: 140, focus: 'plan', tasks: [task({ handoff: { ...handoff, summary: '\n\n  Done, with caveats.' } })] });

    expect(planText(state)).not.toContain('Done, with caveats.');
    expect(planText({ ...state, expandedTaskId: 't1' })).toContain('2 findings · Blocker · Done, with caveats.');
  });

  it('leads with the commit subject, and shows a commit-only handoff', () => {
    const commit = { subject: 'Add the route' };
    const both = initialState({ rows: 24, cols: 140, focus: 'plan', tasks: [task({ handoff: { ...handoff, summary: 'OK', commit } })] });
    expect(planText(both)).not.toContain('Commit: Add the route');
    expect(planText({ ...both, expandedTaskId: 't1' })).toContain('Commit: Add the route');
    const only = initialState({ rows: 24, cols: 140, focus: 'plan', tasks: [task({ handoff: { summary: '', findings: [], findingCount: 0, commit } })] });
    expect(planText(only)).not.toContain('Commit: Add the route');
    expect(planText({ ...only, expandedTaskId: 't1' })).toContain('no findings · Commit: Add the route');
  });

  it('takes the digest from a plan refresh and from a live status update', () => {
    const planned = reduce(initialState({ sessionId: 's1', rows: 24, cols: 100, focus: 'plan' }), {
      type: 'planUpdated',
      sessionId: 's1',
      plan: { tasks: [{ id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'completed', dependencies: [], handoff }] },
    }).state;
    expect(planText(planned)).not.toContain('Added the route.');
    expect(planText({ ...planned, expandedTaskId: 't1' })).toContain('2 findings · Blocker · Added the route.');

    const live = reduce(planned, {
      type: 'runMessage',
      message: {
        type: 'status_update',
        tasks: [{ id: 't1', status: 'completed', verdict: null, handoff: { summary: 'Live done.', findings: [], findingCount: 0 } }],
      },
      sessionId: 's1',
    }).state;
    expect(planText(live)).not.toContain('Live done.');
    expect(planText({ ...live, expandedTaskId: 't1' })).toContain('no findings · Live done.');
  });

  it('says a handoff with no findings has none, as a script and a user task leave', () => {
    const state = initialState({
      rows: 24, cols: 100, focus: 'plan',
      tasks: [task({ type: 'user', handoff: { summary: 'Completed by the user', findings: [], findingCount: 0 } })],
    });

    expect(planText(state)).not.toContain('Completed by the user');
    expect(planText({ ...state, expandedTaskId: 't1' })).toContain('no findings · Completed by the user');
  });

  it.each(['script', 'user'] as const)('keeps a %s handoff available in expanded task details', (type) => {
    const state = initialState({ rows: 24, cols: 100, focus: 'plan', tasks: [task({
      type, handoff: { summary: `${type} result`, findings: [], findingCount: 0 },
    })] });
    expect(planText(state)).not.toContain(`${type} result`);
    expect(planText({ ...state, expandedTaskId: 't1' })).toContain(`no findings · ${type} result`);
  });

  it('shows a child handoff only when that child is expanded and keeps narrow frames exact', () => {
    const child = task({ id: 'child', order: 1, title: 'Nested step', handoff: { ...handoff, summary: 'Child result.' } });
    const parent = task({ id: 'parent', order: 1, title: 'Parent', subtasks: [child] });
    const state = initialState({ rows: 20, cols: 20, focus: 'plan', tasks: [parent] });
    expect(planText({ ...state, expandedTaskId: 'parent' })).not.toContain('Child result.');
    expect(planText({ ...state, expandedTaskId: 'child' })).toContain('Child result.');
    for (const expandedTaskId of [null, 'parent', 'child']) {
      const frame = render({ ...state, expandedTaskId, cols: 20, rows: 20 });
      expect(frame).toHaveLength(20);
      for (const line of frame) expect(width(line)).toBeLessThanOrEqual(20);
    }
  });
});

describe('a task\'s handoff in its view (ADR-0047)', () => {
  it('draws the summary, every finding with its severity, detail and evidence, the artifacts and the folded report', () => {
    const out = plain(opened([{ type: 'handoff', handoff }]));

    expect(out).toContain('Handoff · 2 findings · blocker');
    expect(out).toContain('Added the route.');
    expect(out).toContain('F1 · Blocker · Missing auth');
    expect(out).toContain('Add a guard.');
    expect(out).toContain('Evidence: src/route.ts:12 (unresolved); commit');
    expect(out).toContain('abc123 (unresolved)');
    expect(out).toContain('F2 · Minor · Rename x');
    expect(out).toContain('Evidence: https://example.com/pr/1');
    expect(out).toContain('Artifacts:');
    expect(out).toContain('- src/route.ts');
    expect(out).toContain('Report:');
    expect(out).toContain('report line 8');
    expect(out).not.toContain('report line 9');
    expect(out).toContain('+6 lines of the report (ctrl+o to expand)');
  });

  it('draws the commit, subject then body, before the summary', () => {
    const commit = { subject: 'Add the route', body: 'Guards it.\nNo schema change.' };
    const out = plain(opened([{ type: 'handoff', handoff: { ...handoff, commit } }])).split('\n').map((l) => l.trim());
    const at = (text: string) => out.findIndex((l) => l.includes(text));
    expect(at('Commit: Add the route')).toBeGreaterThan(-1);
    expect(at('Commit: Add the route')).toBeLessThan(at('Guards it.'));
    expect(at('No schema change.')).toBeLessThan(at('Added the route.'));
  });

  it('draws a handoff with only a commit', () => {
    const only: StoredHandoff = { summary: '', findings: [], findingCount: 0, commit: { subject: 'Just this' } };
    expect(plain(opened([{ type: 'handoff', handoff: only }]))).toContain('Commit: Just this');
  });

  it('folds the report back and forth with ctrl-o, the same switch as every long block', () => {
    const folded = opened([{ type: 'handoff', handoff }]);
    expect(footerHints(folded)).toContain('ctrl-o expand all');

    const expanded = plain(pressed(folded, 'ctrl-o'));
    expect(expanded).toContain('report line 14');
    expect(expanded).toContain('(ctrl+o to collapse)');
    expect(footerHints(pressed(folded, 'ctrl-o'))).toContain('ctrl-o collapse all');

    expect(plain(pressed(pressed(folded, 'ctrl-o'), 'ctrl-o'))).not.toContain('report line 9');
  });

  it('says how many findings a digest left in the attempt\'s log', () => {
    const digest: StoredHandoff = { ...handoff, findings: handoff.findings.slice(0, 1), findingCount: 30, report: undefined };
    const out = plain(opened([{ type: 'handoff', handoff: digest }]));

    expect(out).toContain('Handoff · 30 findings · blocker');
    expect(out).toContain('+29 more findings, in the attempt\'s log');
  });

  it('stays inside the pane at every width', () => {
    const state = opened([{ type: 'handoff', handoff }]);
    for (const cols of [20, 40, 60, 80, 120]) {
      const frame = render({ ...state, cols, rows: 30 });
      expect(frame).toHaveLength(30);
      for (const line of frame) expect(width(line)).toBeLessThanOrEqual(cols);
    }
  });

  it('draws a user task\'s handoff from a log that holds nothing else', () => {
    const userHandoff: StoredHandoff = {
      summary: 'Completed by the user',
      findings: [],
      findingCount: 0,
      report: '1. [x] Create the new key',
    };

    const out = plain(opened([{ type: 'handoff', handoff: userHandoff }], { tasks: [task({ type: 'user' })] }));

    expect(out).toContain('Handoff');
    expect(out).toContain('Completed by the user');
    expect(out).toContain('Report:');
    expect(out).toContain('1. [x] Create the new key');
    expect(out).not.toContain('Findings:');
  });

  it('draws a saved patch in full: its changes, base, file and what it left out (ADR-0050)', () => {
    const saved: HandoffPatch = {
      kind: 'patch', path: '.ordewell/sessions/s1/tasks/t1/1.patch', attempt: 1,
      base: 'a'.repeat(40), files: 2, added: 9, removed: 1, binary: 0, bytes: 900, sha256: 'f'.repeat(64),
      flags: [
        { kind: 'excluded', count: 1, paths: ['docs/link'] },
        { kind: 'dropped', count: 1, paths: ['big.bin'] },
      ],
    };
    const out = plain(opened([{ type: 'handoff', handoff: { summary: 'Tried it.', findings: [], findingCount: 0, artifacts: [saved] } }])).replace(/\s+/g, ' ');

    expect(out).toContain('Patch: 2 files, +9 -1, 900 B');
    expect(out).toContain('saved as .ordewell/sessions/s1/tasks/t1/1.patch');
    expect(out).toContain('not carried (links and submodules): 1 file');
    expect(out).toContain('(docs/link)');
    expect(out).toContain('dropped over the size cap: 1 file (big.bin)');
    expect(out).not.toContain('Artifacts:');
  });

  it('names the patch in expanded plan details, before the summary', () => {
    const saved: HandoffPatch = {
      kind: 'patch', path: '.ordewell/sessions/s1/tasks/t1/1.patch', attempt: 1,
      base: 'a'.repeat(40), files: 2, added: 9, removed: 1, binary: 0, bytes: 900, sha256: 'f'.repeat(64),
    };
    const state = initialState({
      rows: 24, cols: 240, focus: 'plan',
      tasks: [task({ handoff: { summary: 'Tried it.', findings: [], findingCount: 0, artifacts: [saved] } })],
    });

    expect(planText(state)).not.toContain('patch: 2 files, +9 -1');
    expect(planText({ ...state, expandedTaskId: 't1' })).toContain('no findings · patch: 2 files, +9 -1');
  });

  it('draws a script task\'s handoff after the step it ran', () => {
    const scriptHandoff: StoredHandoff = {
      summary: 'exited 0 in 2.5 s',
      findings: [],
      findingCount: 0,
      report: 'built',
    };
    const out = plain(opened([
      { type: 'script_run', argv: ['npm', 'run', 'build'] },
      { type: 'script_output', text: 'built' },
      { type: 'script_exit', code: 0, signal: null, durationMs: 2500 },
      { type: 'runner_ended' },
      { type: 'handoff', handoff: scriptHandoff },
    ], { tasks: [task({ type: 'script' })] }));

    expect(out).toContain('Run(npm run build)');
    expect(out).toContain('Handoff');
    expect(out).toContain('exited 0 in 2.5 s');
    expect(out).toContain('Report:');
  });
});
