import { describe, it, expect } from 'vitest';
import { parseTaskQueryJson, readTask, renderTaskQueryAnswer, taskReadDetail, TASK_QUERY_ANSWER_MAX_CHARS, TASK_QUERY_PROTOCOL, TASK_READ_TOOLS_PROTOCOL, type TaskQueryCatalog } from '../TaskQuery';
import { createTask, type Task } from '../../models/Task';
import type { LiveTail } from '../../interfaces/TaskOutputSource';

/**
 * The wire shape and the rendered answer of the task-query read channel,
 * unit level. The channel-level behavior (budgets, injection, both planner
 * backends) is covered in taskQueryChannel.test.ts.
 */

const catalog: TaskQueryCatalog = { runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true };

function tasks(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'Stand up the schema', assignedRunner: 'claude-code' }),
    createTask({ id: 'b', order: 2, title: 'Build', prompt: 'Add POST /login', dependencies: ['a'], assignedRunner: 'claude-code' }),
  ];
}

/** The one fake live-output seam renderTaskQueryAnswer is answered through. */
function fakeLive(tails: Record<string, LiveTail | null>) {
  const asked: { taskId: string; maxLines: number; sinceOffset?: number }[] = [];
  return {
    asked,
    liveOutput: (taskId: string, opts: { maxLines: number; sinceOffset?: number }) => {
      asked.push({ taskId, ...opts });
      return tails[taskId] ?? null;
    },
  };
}

describe('parsing the output read', () => {
  it('accepts the output field, a line count, and a resume offset', () => {
    const query = parseTaskQueryJson(
      '{"taskQuery":{"tasks":["#2"],"fields":["output"],"outputLines":120,"outputSince":450}}',
    );
    expect(query.fields).toEqual(['output']);
    expect(query.outputLines).toBe(120);
    expect(query.outputSince).toBe(450);
  });
});

describe('reading a task\'s skills', () => {
  it('is a field of its own, so an edit can restate the whole list', () => {
    expect(parseTaskQueryJson('{"taskQuery":{"tasks":["#1"],"fields":["skills"]}}').fields).toEqual(['skills']);
    const plan = [createTask({ id: 'a', order: 1, title: 'Setup', skills: ['tdd', 'pr-style'] }), createTask({ id: 'b', order: 2, title: 'Build' })];

    const answer = renderTaskQueryAnswer({ tasks: ['#1', '#2'], fields: ['skills'], catalog: false }, plan, catalog);

    expect(answer).toContain('skills: tdd, pr-style');
    expect(answer).toContain('skills: (none)');
    expect(TASK_QUERY_PROTOCOL.join('\n')).toContain('"skills"');
  });
});

describe('naming a subtask', () => {
  it('heads a subtask by its dotted reference, so a read #2.1 is not taken for top-level #1', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'Setup' }),
      createTask({ id: 'b', order: 2, title: 'Build', subtasks: [createTask({ id: 'b1', order: 1, title: 'Sub' })] }),
    ];

    const answer = renderTaskQueryAnswer({ tasks: ['#2.1'], fields: ['skills'], catalog: false }, plan, catalog);

    expect(answer).toContain('#2.1 id=b1 "Sub"');
    expect(answer).not.toContain('#1 id=b1');
  });
});

describe('rendering the output read', () => {
  it('answers a running task with its clean tail, the resume offset, and a running marker', () => {
    const { asked, liveOutput } = fakeLive({ b: { text: 'compiling\nlinking', nextOffset: 1234, running: true } });
    const answer = renderTaskQueryAnswer(
      { tasks: ['#2'], fields: ['output'], catalog: false, outputSince: 800 },
      tasks(),
      catalog,
      liveOutput,
    );

    expect(answer).toContain('compiling');
    expect(answer).toContain('linking');
    expect(answer).toContain('1234');
    expect(answer).toContain('outputSince');
    expect(asked).toEqual([{ taskId: 'b', maxLines: 80, sinceOffset: 800 }]);
  });

  it('tells a planner the tail of an ended task is not live, and where the outcome lives', () => {
    const { asked, liveOutput } = fakeLive({ b: { text: 'Done. 12 files changed.', nextOffset: 40, running: false } });
    const answer = renderTaskQueryAnswer(
      { tasks: ['#2'], fields: ['output'], catalog: false },
      tasks(),
      catalog,
      liveOutput,
    );

    expect(answer).toContain('not running');
    expect(answer).toContain('outputSummary');
    expect(answer).toContain('verdict');
    // The ended attempt's tail is not re-served here; outputSummary owns it.
    expect(answer).not.toContain('Done. 12 files changed.');
    expect(asked).toEqual([{ taskId: 'b', maxLines: 80 }]);
  });

  it('answers an ended task with its whole report, before any log tail', () => {
    const reviewed = tasks();
    const report = Array.from({ length: 60 }, (_, i) => `${i + 1}. services/Auth.ts:${i + 1} swallows the refresh error`).join('\n');
    reviewed[0].outputSummary = { reviewReason: 'Verified', report, logTail: '', capturedAt: 'x' };
    reviewed[1].outputSummary = { reviewReason: 'Failed verification', logTail: 'npm ERR! missing script', capturedAt: 'x' };
    const answer = renderTaskQueryAnswer({ tasks: ['#1', '#2'], fields: ['outputSummary'], catalog: false }, reviewed, catalog);

    expect(answer).toContain(`outputSummary: Verified\nreport:\n${report}\n`);
    expect(answer).toContain('outputSummary: Failed verification\nlog tail:\nnpm ERR! missing script');
  });

  it('answers a task\'s handoff with each finding, the tasks it cites by reference, and where the rest is; its report is the handoff\'s, not the summary\'s', () => {
    const reviewed = tasks();
    reviewed[1].outputSummary = { reviewReason: 'Verified', report: 'The handoff, as one text.', logTail: '', capturedAt: 'x' };
    reviewed[1].handoff = {
      summary: 'Login works; the refresh path does not.',
      findings: [{ id: 'F1', severity: 'major', title: 'Refresh swallows errors', detail: 'services/Auth.ts drops the 401.', evidence: [{ kind: 'task', task: 'a', finding: 'F2' }] }],
      findingCount: 3,
      artifacts: [{ kind: 'file', path: 'docs/auth.md' }],
    };
    const answer = renderTaskQueryAnswer({ tasks: ['#1', '#2'], catalog: false }, reviewed, catalog);

    expect(answer).toContain('handoff: (none)');
    expect(answer).toContain([
      'outputSummary: Verified',
      'handoff:',
      'Login works; the refresh path does not.',
      '',
      'Findings:',
      '- F1 [major] Refresh swallows errors',
      '  services/Auth.ts drops the 401.',
      '  Evidence: #1/F2',
      '+2 more findings, in the attempt\'s log',
      '',
      'Artifacts: docs/auth.md (unresolved)',
      '(The whole handoff, report and all, is in the attempt\'s log.)',
    ].join('\n'));
    expect(answer).not.toContain('The handoff, as one text.');
  });

  it('answers a task\'s handoff with its commit first, subject then body', () => {
    const changed = tasks();
    changed[0].handoff = { commit: { subject: 'Add the parser', body: 'The old one choked on commas.' }, summary: 'parse() is in src/csv.ts.', findings: [], findingCount: 0 };

    const answer = renderTaskQueryAnswer({ tasks: ['#1'], fields: ['handoff'], catalog: false }, changed, catalog);

    expect(answer).toContain('handoff:\nCommit: Add the parser\nThe old one choked on commas.\n\nparse() is in src/csv.ts.\n(The whole handoff');
  });

  it('says when a task has never run in this session instead of answering silence', () => {
    const { asked, liveOutput } = fakeLive({});
    const answer = renderTaskQueryAnswer(
      { tasks: ['#2'], fields: ['output'], catalog: false },
      tasks(),
      catalog,
      liveOutput,
    );

    expect(answer).toContain('no captured output');
    expect(asked).toEqual([{ taskId: 'b', maxLines: 80 }]);
  });

  it('caps the line count the tail is asked for, however many lines the query wants', () => {
    const { asked, liveOutput } = fakeLive({ b: { text: 'tail', nextOffset: 5, running: true } });
    renderTaskQueryAnswer(
      { tasks: ['#2'], fields: ['output'], catalog: false, outputLines: 999 },
      tasks(),
      catalog,
      liveOutput,
    );

    expect(asked).toEqual([{ taskId: 'b', maxLines: 400 }]);
  });

  it('rejects an output read whose counts are not usable', () => {
    expect(() => parseTaskQueryJson('{"taskQuery":{"tasks":["#2"],"fields":["output"],"outputLines":0}}')).toThrow();
    expect(() => parseTaskQueryJson('{"taskQuery":{"tasks":["#2"],"fields":["output"],"outputLines":-3}}')).toThrow();
    expect(() => parseTaskQueryJson('{"taskQuery":{"tasks":["#2"],"fields":["output"],"outputLines":"many"}}')).toThrow();
    expect(() => parseTaskQueryJson('{"taskQuery":{"tasks":["#2"],"fields":["output"],"outputSince":-1}}')).toThrow();
  });

  it('keeps the answer within its character budget, keeping the newest output', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-` + 'x'.repeat(300));
    const { liveOutput } = fakeLive({ b: { text: lines.join('\n'), nextOffset: 31_000, running: true } });
    const answer = renderTaskQueryAnswer(
      { tasks: ['#2'], fields: ['output'], catalog: false },
      tasks(),
      catalog,
      liveOutput,
    );

    expect(answer.length).toBeLessThanOrEqual(TASK_QUERY_ANSWER_MAX_CHARS);
    expect(answer).toContain(`line-${lines.length - 1}-`);
    expect(answer).not.toContain('line-0-');
    expect(answer).toContain('trimmed');
  });
});

describe('one read of a task, for both channels', () => {
  function loopPlan(): Task[] {
    return [
      createTask({
        id: 'review', order: 1, title: 'Review', prompt: 'Review the cache', status: 'failed',
        loop: { body: ['fix'], maxRounds: 3 }, loopRound: 2,
        verdict: {
          outcome: 'fail', reason: 'Two holes.', decidedAt: 'x', reported: 'failed',
          checks: [{ name: 'task_complete', passed: false, skipped: false, detail: 'reported failed' }],
        },
      }),
      createTask({ id: 'fix', order: 2, title: 'Fix', prompt: 'Fix it', dependencies: ['review'] }),
    ];
  }

  it('states the loop position once, and each channel words it for its reader', () => {
    const plan = loopPlan();
    const check = readTask(plan, plan[0], ['description']);
    const body = readTask(plan, plan[1], ['description']);

    expect(check.loop).toEqual({ body: ['#2'], maxRounds: 3, round: 2, betweenRounds: true });
    expect(body.loop).toEqual({ check: '#1', checkTitle: 'Review' });

    expect(taskReadDetail(check).loop).toEqual({ body: ['#2'], maxRounds: 3, round: 2, betweenRounds: true });
    expect(taskReadDetail(body).loop).toEqual({ check: '#1' });

    const verdict = readTask(plan, plan[0], ['verdict']);
    expect(verdict.verdict).toEqual({ outcome: 'fail', reason: 'Two holes.', checks: [{ name: 'task_complete', result: 'fail' }] });
    expect(taskReadDetail(verdict).verdict).toEqual(verdict.verdict);

    const text = renderTaskQueryAnswer({ tasks: ['#1', '#2'], fields: ['description'], catalog: false }, plan, catalog);
    expect(text).toContain('loop: body #2; at most 3 rounds; failed round 2, so its body is fixing what it found and it runs again after');
    expect(text).toContain('loop: in the body of #1 "Review", so it runs only when that check fails');
    expect(renderTaskQueryAnswer({ tasks: ['#1'], fields: ['verdict'], catalog: false }, plan, catalog)).toContain('verdict: FAIL — Two holes. [task_complete=fail]');
  });

  it('gives a handoff\'s report to the handoff, and the summary keeps only how the attempt ended', () => {
    const plan = tasks();
    plan[1].outputSummary = { reviewReason: 'Verified', report: 'The whole story.', logTail: '', capturedAt: 'x' };
    plan[1].handoff = {
      summary: 'Login works; the refresh path does not.',
      findings: [{ id: 'F1', severity: 'major', title: 'Refresh swallows errors', evidence: [{ kind: 'task', task: 'a', finding: 'F2' }] }],
      findingCount: 2,
    };

    const read = readTask(plan, plan[1], ['outputSummary', 'handoff']);
    const rest = 'Findings F2 to F2 and the report are in the attempt\'s log: read them with task_output.';
    expect(read.outputSummary).toEqual({ reviewReason: 'Verified' });
    expect(read.handoff).toMatchObject({ summary: 'Login works; the refresh path does not.', rest });
    expect(read.handoff?.findings[0].evidence).toEqual([{ kind: 'task', task: '#1', finding: 'F2' }]);

    // The same rule reaches the tool's JSON: the summary carries no report, the handoff's rest points at it.
    const detail = taskReadDetail(read);
    expect(detail.outputSummary).toEqual({ reviewReason: 'Verified' });
    expect(detail.handoff).toMatchObject({ rest });

    const text = renderTaskQueryAnswer({ tasks: ['#2'], fields: ['outputSummary', 'handoff'], catalog: false }, plan, catalog);
    expect(text).toContain('outputSummary: Verified\nhandoff:');
    expect(text).not.toContain('The whole story.');
  });

  it('keeps an unasked field out of the read, and answers an asked-for empty one with null', () => {
    const plan = tasks();
    const read = readTask(plan, plan[1], ['description', 'skills']);

    expect(read.description).toBeNull();
    expect(read.skills).toBeNull();
    expect(read).not.toHaveProperty('prompt');

    const detail = taskReadDetail(read);
    expect(detail.description).toBeNull();
    expect(detail.skills).toBeNull();
    expect(detail).not.toHaveProperty('prompt');
    expect(detail).not.toHaveProperty('userSteps');
  });

  it('reads a script task\'s body in place of a prompt for both channels', () => {
    const plan = [createTask({ id: 's', order: 1, title: 'Deploy', type: 'script', commands: [['git', 'push']], timeoutMs: 60_000 })];
    const read = readTask(plan, plan[0], ['prompt']);

    expect(read.body).toEqual({ commands: [['git', 'push']], timeoutMs: 60_000 });
    expect(taskReadDetail(read)).toMatchObject({ type: 'script', body: { commands: [['git', 'push']], timeoutMs: 60_000 } });
    expect(taskReadDetail(read)).not.toHaveProperty('prompt');

    const text = renderTaskQueryAnswer({ tasks: ['#1'], fields: ['prompt'], catalog: false }, plan, catalog);
    expect(text).toContain('commands:\n  $ git push\ntimeoutMs: 60000');
  });
});

describe('the protocol as the planner is taught it', () => {
  it('teaches the output read, its paging options, and when to use it', () => {
    const protocol = TASK_QUERY_PROTOCOL.join('\n');
    expect(protocol).toContain('"output"');
    expect(protocol).toContain('outputLines');
    expect(protocol).toContain('outputSince');
    expect(protocol).toContain('running');
    expect(protocol).toContain('stuck');
  });

  it('says the plan block comes whole once, then as what changed, never every turn', () => {
    for (const lines of [TASK_QUERY_PROTOCOL, TASK_READ_TOOLS_PROTOCOL]) {
      const protocol = lines.join('\n');
      expect(protocol).toMatch(/The plan block you are shown \(whole once per live context, then what changed\) carries only short fields/);
      expect(protocol).not.toMatch(/each turn|every turn/);
    }
    expect(TASK_READ_TOOLS_PROTOCOL.join('\n')).toContain('the last whole plan block shows you its operations; later turns only say what changed');
  });
});
