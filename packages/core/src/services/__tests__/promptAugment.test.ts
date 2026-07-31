import { describe, it, expect } from 'vitest';
import { createTask } from '../../models/Task';
import { augmentPromptWithPriorOutputs, composeAugmentedPrompt, renderPlanMap, summarizeOutput } from '../promptAugment';

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

  it('includes TDD instructions when tddEnabled is true', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks, { tddEnabled: true });
    expect(out).toContain('## Implementation workflow (TDD)');
    expect(out).toContain('RED: Write ONE failing test');
    expect(out).toContain('GREEN: Write minimal production code');
    expect(out).toContain('Refactoring is not part of the red-green cycle');
    expect(out).toContain('run the full test suite once at the end of the task');
  });

  it('omits TDD instructions when tddEnabled is false', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks, { tddEnabled: false });
    expect(out).not.toContain('## Implementation workflow (TDD)');
  });

  it('omits TDD instructions when tddEnabled is not set', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks);
    expect(out).not.toContain('## Implementation workflow (TDD)');
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
    const out = composeAugmentedPrompt(tasks[0], tasks, { tddEnabled: true });
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
    expect(out).toContain('<<<ORDEWELL-DONE_mk-a>>>');
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

  it('includes both TDD and checkpoint instructions when applicable', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'do work', autonomy: 'HITL' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'pb' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'pc' }),
    ];
    const out = composeAugmentedPrompt(tasks[0], tasks, { tddEnabled: true });
    expect(out).toContain('## Implementation workflow (TDD)');
    expect(out).toContain('## Human-in-the-loop checkpoints');
    // TDD should come before HITL instructions
    const tddIdx = out.indexOf('## Implementation workflow (TDD)');
    const hitlIdx = out.indexOf('## Human-in-the-loop checkpoints');
    expect(tddIdx).toBeGreaterThan(0);
    expect(hitlIdx).toBeGreaterThan(tddIdx);
    // Both before the base prompt
    expect(out.indexOf('do work')).toBeGreaterThan(hitlIdx);
  });
});
