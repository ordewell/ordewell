import { describe, it, expect } from 'vitest';
import { createTask, resolveOrderLabel, type TaskSkillSnapshot } from '../../models/Task';
import { augmentPromptWithPriorOutputs, composeAugmentedPrompt, composeContinuationPrompt, renderPlanMap, summarizeOutput } from '../promptAugment';

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
      createTask({ id: 'c', order: 3, title: 'Blocked one', status: 'blocked' }),
      createTask({ id: 'd', order: 4, title: 'Manual one', type: 'user' }),
      createTask({ id: 'e', order: 5, title: 'Pending one' }),
      createTask({ id: 'f', order: 6, title: 'Running one', status: 'in_progress' }),
    ];
    const out = renderPlanMap(tasks, 'e');
    expect(out).toMatch(/\[done\s*\] Done one/);
    expect(out).toMatch(/\[failed\s*\] Failed one/);
    expect(out).toMatch(/\[blocked\] Blocked one/);
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
    expect(resolveOrderLabel([solo, parent], '2.1')?.id).toBe('s1');
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
    const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'solo', completionMarker: 'mk-a' });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });
    // <3 tasks → no plan map. No deps → no prior outputs.
    const out = composeAugmentedPrompt(a, [a, b]);
    expect(out).toContain('DONE_mk-a>>>');
    expect(out.startsWith('solo\n\nWhen you')).toBe(true);
  });

  it('appends a completion marker instruction with the task UUID', () => {
    const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });
    const c = createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc', completionMarker: 'marker-uuid-123' });

    const out = composeAugmentedPrompt(c, [a, b, c]);
    expect(out).toContain('<<<ORDEWELL_');
    expect(out).toContain('DONE_marker-uuid-123>>>');
    expect(out).toContain('When you have fully completed this task');
  });

  it('never contains the assembled completion token — TUIs echo the prompt and the watcher scans terminal output', () => {
    const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', completionMarker: 'mk-echo' });
    const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });

    const out = composeAugmentedPrompt(a, [a, b]);
    expect(out).not.toContain('<<<ORDEWELL_DONE_mk-echo>>>');
    // even after whitespace collapsing (terminal soft-wrap flattening)
    expect(out.replace(/\s+/g, '')).not.toContain('<<<ORDEWELL_DONE_mk-echo>>>');
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

  it('includes checkpoint instructions for HITL tasks (autonomy=HITL)', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', autonomy: 'HITL' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks);
    expect(out).toContain('## Human-in-the-loop checkpoints');
    expect(out).toContain('<<<ORDEWELL_');
    expect(out).toContain('CHECKPOINT:');
    expect(out).toContain('ORDEWELL_CONTINUE');
  });

  it('never contains an assembled checkpoint token — an echoed prompt would checkpoint the task on spawn', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', autonomy: 'HITL' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks, { skills: [TDD] });
    const checkpoint = /<<<ORDEWELL_CHECKPOINT:\s*(.*?)>>>/gs;
    expect(out).not.toMatch(checkpoint);
    // and after the soft-wrap flattening the watcher also scans
    expect(out.replace(/\s+/g, '')).not.toMatch(checkpoint);
  });

  it('defuses marker tokens carried in a predecessor output tail', () => {
    const dep = createTask({ id: 'a', order: 1, title: 'A', prompt: 'pa' });
    dep.outputSummary = {
      reviewReason: 'done after <<<ORDEWELL_CHECKPOINT: ask the user>>>',
      logTail: 'final line: <<<ORDEWELL_DONE_mk-a>>>',
      capturedAt: '2026-01-01T00:00:00.000Z',
    };
    const task = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb', dependencies: ['a'] });

    const out = composeAugmentedPrompt(task, [dep, task]);
    expect(out).not.toMatch(/<<<ORDEWELL_CHECKPOINT:\s*(.*?)>>>/gs);
    expect(out).not.toContain('<<<ORDEWELL_DONE_mk-a>>>');
    // the text is still readable — only the token opener is broken
    expect(out).toContain('<<<ORDEWELL-CHECKPOINT: ask the user>>>');
    expect(out).toContain('<<<ORDEWELL-DONE>>>');
  });

  // A transcript is bound to its task by the marker id its prompt carries, so a
  // dependent's transcript must not carry its predecessor's: a re-run of the
  // predecessor would otherwise take the dependent's answer as its own.
  it("never carries a predecessor's completion marker id into a dependent's prompt", () => {
    const dep = createTask({ id: 'a', order: 1, title: 'A', prompt: 'pa', completionMarker: '0f6c2a1e-mk-a' });
    dep.outputSummary = {
      reviewReason: 'Verified: completion marker detected in agent output.',
      logTail: 'All done.\n<<<ORDEWELL_DONE_0f6c2a1e-mk-a>>>',
      capturedAt: '2026-01-01T00:00:00.000Z',
    };
    const task = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb', dependencies: ['a'], completionMarker: 'mk-b' });

    const out = composeAugmentedPrompt(task, [dep, task]);
    expect(out).toContain('All done.');
    expect(out).not.toContain('0f6c2a1e-mk-a');
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

describe('the completion instruction where the task_complete tool is given (ADR-0022)', () => {
  const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', completionMarker: 'mk-tool' });
  const b = createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' });

  it('asks for the tool call first, and for the marker in two halves as the fallback', () => {
    const out = composeAugmentedPrompt(a, [a, b], { completionTool: true });

    expect(out).toContain('call the `task_complete` tool with status `done`');
    expect(out).toContain('`blocked` or `failed`');
    expect(out.indexOf('task_complete')).toBeLessThan(out.indexOf('DONE_mk-tool>>>'));
    expect(out).toContain('`<<<ORDEWELL_` immediately followed by `DONE_mk-tool>>>`');
    expect(out).not.toContain('<<<ORDEWELL_DONE_mk-tool>>>');
  });

  it('names no tool where none is given', () => {
    expect(composeAugmentedPrompt(a, [a, b])).not.toContain('task_complete');
    expect(composeContinuationPrompt(a, 'go on')).not.toContain('task_complete');
  });

  it('asks a continued task for the tool call too', () => {
    const out = composeContinuationPrompt(a, 'go on', { completionTool: true });

    expect(out).toContain('call the `task_complete` tool with status `done`');
    expect(out).toContain('`<<<ORDEWELL_` immediately followed by `DONE_mk-tool>>>`');
  });
});

describe('the checkpoint instruction where the checkpoint tool is given (ADR-0022, V5)', () => {
  const a = createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', completionMarker: 'mk-tool', autonomy: 'HITL' });

  it('asks for the tool call first, and for the marker in two halves as the fallback', () => {
    const out = composeAugmentedPrompt(a, [a], { completionTool: true });

    expect(out).toContain('## Human-in-the-loop checkpoints');
    expect(out).toContain('Call the `checkpoint` tool');
    expect(out).toContain('`continue`');
    expect(out).toContain('`rejected:`');
    expect(out.indexOf('Call the `checkpoint` tool')).toBeLessThan(out.indexOf('`<<<ORDEWELL_` immediately followed by `CHECKPOINT:`'));
    expect(out).not.toMatch(/<<<ORDEWELL_CHECKPOINT/);
  });

  it('teaches only the marker where no tool is given', () => {
    expect(composeAugmentedPrompt(a, [a])).not.toContain('`checkpoint` tool');
    expect(composeContinuationPrompt(a, 'go on')).not.toContain('`checkpoint` tool');
  });

  it('reminds a continued task of the tool, with the marker as the fallback', () => {
    const out = composeContinuationPrompt(a, 'go on', { completionTool: true });

    expect(out).toContain('call the `checkpoint` tool');
    expect(out).toContain('`<<<ORDEWELL_` immediately followed by `CHECKPOINT:`');
    expect(out).not.toContain('<<<ORDEWELL_CHECKPOINT');
  });
});

describe('composeContinuationPrompt (ADR-0018, K1)', () => {
  const task = createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'ORIGINAL PROMPT BODY', completionMarker: 'mk-1' });

  it('leads with the user\'s message and ends with the task\'s own done marker, in two halves', () => {
    const prompt = composeContinuationPrompt(task, '  also handle arrays \n');

    expect(prompt.startsWith('also handle arrays\n')).toBe(true);
    expect(prompt).toContain('continuing this task in the same session');
    expect(prompt).toContain('recreated from the integration branch');
    expect(prompt.endsWith('`<<<ORDEWELL_` immediately followed by `DONE_mk-1>>>` — joined into a single unbroken token, with no space, quote, or any other character between the two parts.')).toBe(true);
    expect(prompt).not.toContain('<<<ORDEWELL_DONE_mk-1>>>');
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

  it('reminds a HITL task of the checkpoint protocol, without a literal checkpoint marker', () => {
    const plain = composeContinuationPrompt(task, 'go on');
    const hitl = composeContinuationPrompt({ ...task, autonomy: 'HITL' }, 'go on');

    expect(plain).not.toContain('CHECKPOINT');
    expect(hitl).toContain('`<<<ORDEWELL_` immediately followed by `CHECKPOINT:`');
    expect(hitl).toContain('ORDEWELL_CONTINUE or ORDEWELL_REJECT');
    expect(hitl).not.toContain('<<<ORDEWELL_CHECKPOINT');
  });
});

describe('composeAugmentedPrompt — an ops task\'s previous attempt (ADR-0020)', () => {
  const task = createTask({ id: 'o1', order: 1, title: 'Deploy', prompt: 'deploy it', completionMarker: 'mk-o1', ops: true });

  it('carries the last attempt\'s output and asks to check what exists before acting', () => {
    const prompt = composeAugmentedPrompt(task, [task], { previousAttempt: 'created rg-dev\n' });

    expect(prompt).toContain('## Previous attempt');
    expect(prompt).toContain('check what already exists');
    expect(prompt).toContain('  created rg-dev');
  });

  it('defuses a done marker the last attempt printed, so the retry cannot pass on it', () => {
    const prompt = composeAugmentedPrompt(task, [task], { previousAttempt: 'almost <<<ORDEWELL_DONE_mk-o1>>>' });

    expect(prompt.split('## Previous attempt')[1]).not.toContain('<<<ORDEWELL_DONE_mk-o1>>>');
  });

  it('says so when the last attempt printed nothing, and adds nothing on a first attempt', () => {
    expect(composeAugmentedPrompt(task, [task], { previousAttempt: '  ' })).toContain('(no output captured)');
    expect(composeAugmentedPrompt(task, [task], {})).not.toContain('## Previous attempt');
  });
});
