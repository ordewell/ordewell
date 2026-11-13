import { describe, it, expect } from 'vitest';
import { parsePlanJson, looksLikePlanAttempt, validatePlanTasks } from '../PlanValidator';
import { generatePlanWithRepair, JSON_REPAIR_INSTRUCTION } from '../PlanRepair';
import { extractJsonObject, PlanParseError } from '../JsonExtractor';
import { parsePartialPlan } from '../PartialPlanParser';
import { autonomyLevelLabel, parseAutonomyLevel } from '../ModeResolver';
import { buildResearchPrompt, buildPlanWithResults } from '../PlanPrompts';

import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';

const modes = (over: Partial<PlannerModes> = {}): PlannerModes => ({ ...DEFAULT_PLANNER_MODES, ...over });

const onePlan = (extra: Record<string, unknown> = {}) => JSON.stringify({
  tasks: [{
    id: 't1',
    order: 1,
    title: 'Read README',
    description: 'Read the project README',
    type: 'ai',
    dependencies: [],
    prompt: 'Open README.md and summarize it.',
    subtasks: [],
    sliceType: 'AFK',
    autonomy: 'AFK',
    ...extra,
  }],
});

const RUNNERS = ['claude-code'];

describe('parsePlanJson', () => {
  it('parses a minimal happy-path plan', () => {
    const tasks = parsePlanJson(onePlan(), RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
    expect(tasks[0].title).toBe('Read README');
    expect(tasks[0].type).toBe('ai');
    expect(tasks[0].dependencies).toEqual([]);
    expect(tasks[0].prompt).toContain('README');
  });

  it('falls back to description when the model omits prompt on an AI task', () => {
    // A task with no prompt at all is otherwise silently unschedulable forever
    // (TaskOrchestrator.getReadyTasks requires a truthy prompt) — the planner
    // must never ship one, so this mirrors the description/title fallback
    // TaskOps.applyTaskOps already uses for a manually-added task.
    const tasks = parsePlanJson(onePlan({ prompt: undefined }), RUNNERS);
    expect(tasks[0].prompt).toBe('Read the project README');
  });

  it('reads "ops" on a top-level AI task only (ADR-0020)', () => {
    const deploy = { id: 'o1', order: 1, title: 'Deploy', description: 'Deploy', type: 'ai', prompt: 'deploy', autonomy: 'AFK', sliceType: 'AFK', ops: true };
    const change = { id: 't3', order: 3, title: 'Change', description: 'Change', type: 'ai', prompt: 'change', autonomy: 'AFK', sliceType: 'AFK' };
    expect(parsePlanJson(JSON.stringify({ tasks: [deploy, change] }), RUNNERS).map((t) => t.ops)).toEqual([true, undefined]);

    const watch = { id: 's1', order: 1, title: 'Watch', description: 'Watch', type: 'ai', prompt: 'watch', ops: true };
    const check = { id: 'u2', order: 2, title: 'Check', description: 'Check', type: 'user', sliceType: 'HITL', ops: true, userSteps: [{ order: 1, instruction: 'look' }] };
    expect(() => parsePlanJson(JSON.stringify({ tasks: [{ ...deploy, subtasks: [watch] }, change] }), RUNNERS)).toThrow(/only a top-level task can be an ops task/);
    expect(() => parsePlanJson(JSON.stringify({ tasks: [deploy, check] }), RUNNERS)).toThrow(/only an AI task can be an ops task/);
  });

  it('falls back to title when the model omits both prompt and description', () => {
    const tasks = parsePlanJson(onePlan({ prompt: undefined, description: undefined }), RUNNERS);
    expect(tasks[0].prompt).toBe('Read README');
  });

  it('strips ```json fences', () => {
    const wrapped = '```json\n' + onePlan() + '\n```';
    expect(() => parsePlanJson(wrapped, RUNNERS)).not.toThrow();
    expect(parsePlanJson(wrapped, RUNNERS)).toHaveLength(1);
  });

  it('strips bare ``` fences', () => {
    const wrapped = '```\n' + onePlan() + '\n```';
    expect(parsePlanJson(wrapped, RUNNERS)).toHaveLength(1);
  });

  it('repairs raw newlines/tabs inside string values (budget models emit multi-line prompts)', () => {
    // Hand-built JSON with literal control chars inside the prompt string —
    // strict JSON.parse rejects this with "bad control character".
    const raw = onePlan().replace(
      '"prompt":"Open README.md and summarize it."',
      '"prompt":"Open README.md.\nThen summarize it.\n\tKeep it short."',
    );
    expect(raw).toContain('\nThen'); // the replace actually hit
    const tasks = parsePlanJson(raw, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('Open README.md.\nThen summarize it.\n\tKeep it short.');
  });

  it('leaves escaped sequences and formatting whitespace untouched when repairing control chars', () => {
    const pretty = [
      '{',
      '  "tasks": [',
      '    { "id": "t1", "order": 1, "title": "A \\"quoted\\" title", "description": "d",',
      '      "type": "ai", "dependencies": [], "prompt": "line1\\nline2", "subtasks": [], "sliceType": "AFK", "autonomy": "AFK" }',
      '  ]',
      '}',
    ].join('\n');
    const tasks = parsePlanJson(pretty, RUNNERS);
    expect(tasks[0].title).toBe('A "quoted" title');
    expect(tasks[0].prompt).toBe('line1\nline2');
  });

  it('throws PlanParseError when tasks array is missing', () => {
    expect(() => parsePlanJson('{}', RUNNERS)).toThrow(PlanParseError);
    expect(() => parsePlanJson('{}', RUNNERS)).toThrow(/missing tasks/);
  });

  it('throws PlanParseError when tasks is not an array', () => {
    expect(() => parsePlanJson('{"tasks": "not-an-array"}', RUNNERS)).toThrow(/missing tasks/);
  });

  it('throws PlanParseError on an empty tasks array (never a usable plan)', () => {
    expect(() => parsePlanJson('{"tasks": []}', RUNNERS)).toThrow(PlanParseError);
    expect(() => parsePlanJson('{"tasks": []}', RUNNERS)).toThrow(/no tasks/);
  });

  it('throws a typed PlanParseError (not a raw SyntaxError) on malformed JSON', () => {
    expect(() => parsePlanJson('{not valid json', RUNNERS)).toThrow(PlanParseError);
  });

  it('carries the original raw text on the thrown PlanParseError', () => {
    const raw = 'totally not json';
    try {
      parsePlanJson(raw, RUNNERS);
      throw new Error('expected parsePlanJson to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanParseError);
      expect((err as PlanParseError).raw).toBe(raw);
    }
  });

  it('tolerates a prose preamble around the JSON', () => {
    const tasks = parsePlanJson('Here is your plan:\n' + onePlan(), RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('tolerates trailing prose after the JSON', () => {
    const tasks = parsePlanJson(onePlan() + '\n\nHope this helps!', RUNNERS);
    expect(tasks).toHaveLength(1);
  });

  it('ignores braces that appear inside string values when extracting', () => {
    const tasks = parsePlanJson(onePlan({ prompt: 'Use the object literal { foo: 1 } as a fixture.' }), RUNNERS);
    expect(tasks[0].prompt).toContain('{ foo: 1 }');
  });

  it('throws PlanParseError on a truncated (unbalanced) response', () => {
    const truncated = onePlan().slice(0, onePlan().length - 5);
    expect(() => parsePlanJson(truncated, RUNNERS)).toThrow(PlanParseError);
  });

  it('reports a truncated response as a length/truncation error, not a generic format error', () => {
    const truncated = onePlan().slice(0, onePlan().length - 5);
    expect(() => parsePlanJson(truncated, RUNNERS)).toThrow(/truncat|length|cut off|incomplete/i);
  });

  it('ignores a <think> reasoning block (with stray braces) before the plan', () => {
    const raw = '<think>\nLet me consider { the structure } and the { edge cases }.\n</think>\n' + onePlan();
    const tasks = parsePlanJson(raw, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('finds the plan object even when an earlier non-tasks object precedes it', () => {
    const raw = '{"reasoning":"first I thought about it"}\n\n' + onePlan();
    const tasks = parsePlanJson(raw, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Read README');
  });

  it('tolerates a reasoning preamble containing a stray brace', () => {
    const raw = 'Considering the shape { of the plan...\n' + onePlan();
    const tasks = parsePlanJson(raw, RUNNERS);
    expect(tasks).toHaveLength(1);
  });

  it('prefers the LAST tasks-keyed object when a schema echo precedes the real plan', () => {
    // Models sometimes repeat the prompt's one-task JSON template before the
    // actual plan; the template must never win over the real (later) plan.
    const echo = '{"tasks":[{"id":"unique-task-id","order":1,"title":"Concise title","description":"What this task accomplishes","type":"ai","dependencies":[],"subtasks":[],"sliceType":"AFK","autonomy":"AFK"}]}';
    const real = JSON.stringify({
      tasks: [
        { id: 'a', order: 1, title: 'First', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' },
        { id: 'b', order: 2, title: 'Second', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' },
      ],
    });
    const tasks = parsePlanJson(`Following the format ${echo} here is the plan:\n${real}`, RUNNERS);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('falls back to an earlier valid plan when the last tasks-keyed object is unusable', () => {
    const junk = '{"tasks":[{"title":"missing everything"}]}';
    const tasks = parsePlanJson(`${onePlan()}\nFor edits you could send ${junk}`, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('tolerates trailing commas in objects and arrays', () => {
    const raw = '{"tasks":[{"id":"t1","order":1,"title":"T","description":"d","type":"ai","dependencies":[],"subtasks":[],"sliceType":"AFK","autonomy":"AFK",},],}';
    const tasks = parsePlanJson(raw, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  // Read as "ai" once, while submit_plan's schema refused it: the routes now agree, as an edit's type already did.
  it('refuses a task type no kind owns, never reading it as "ai"', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 't', description: 'd', type: 'something-weird', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
    });
    expect(() => parsePlanJson(raw, RUNNERS)).toThrow(/"something-weird", which is no kind of task/);
  });

  it('parses type "user" as user task', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'u', order: 1, title: 't', description: 'd', type: 'user', dependencies: [], sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'Do X', completed: true }], subtasks: [] }],
    });
    const t = parsePlanJson(raw, RUNNERS)[0];
    expect(t.type).toBe('user');
    expect(t.userSteps).toHaveLength(1);
    expect(t.userSteps?.[0].completed).toBe(false);
  });

  it('defaults missing dependencies to empty array', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 't', description: 'd', type: 'ai', subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
    });
    expect(parsePlanJson(raw, RUNNERS)[0].dependencies).toEqual([]);
  });

  it('parses assignedModel with thinkingEffort', () => {
    const tasks = parsePlanJson(onePlan({
      assignedModel: { modelId: 'm-1', modelLabel: 'Model 1', thinkingEffort: 'high' },
    }), RUNNERS);
    expect(tasks[0].assignedModel?.modelId).toBe('m-1');
    expect(tasks[0].assignedModel?.thinkingEffort).toBe('high');
  });

  it('accepts assignedRunner from the valid runners set', () => {
    const ok = parsePlanJson(onePlan({ assignedRunner: 'opencode' }), ['claude-code', 'opencode']);
    expect(ok[0].assignedRunner).toBe('opencode');
  });

  it('accepts assignedRunner for single-runner plans', () => {
    const ok = parsePlanJson(onePlan({ assignedRunner: 'claude-code' }), ['claude-code']);
    expect(ok[0].assignedRunner).toBe('claude-code');
  });

  it('rejects assignedRunner not in the multi-runner set', () => {
    expect(() => parsePlanJson(onePlan({ assignedRunner: 'bogus-runner' }), ['claude-code', 'opencode']))
      .toThrow(PlanParseError);
  });

  it('rejects assignedRunner not in the single-runner set', () => {
    expect(() => parsePlanJson(onePlan({ assignedRunner: 'bogus-runner' }), ['claude-code']))
      .toThrow(PlanParseError);
  });

  it('defaults taskMode to build when unspecified', () => {
    expect(parsePlanJson(onePlan(), RUNNERS)[0].taskMode).toBe('build');
  });

  it('gives a readOnly task "plan"', () => {
    expect(parsePlanJson(onePlan({ readOnly: true }), RUNNERS)[0].taskMode).toBe('plan');
  });

  it('recurses into subtasks', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'p', description: 'd', type: 'ai', dependencies: [], sliceType: 'AFK', autonomy: 'AFK',
        subtasks: [{ id: 'child', order: 1, title: 'c', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
      }],
    });
    const t = parsePlanJson(raw, RUNNERS)[0];
    expect(t.subtasks).toHaveLength(1);
    expect(t.subtasks[0].id).toBe('child');
  });

  // Budget models emit sub-steps as bare {id, order, title, description, type};
  // rejecting the whole plan for that threw away usable plans. Inheriting from
  // the parent invents nothing — an ai sub-step of an AFK slice is AFK.
  it('lets bare ai subtasks inherit their parent classification', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'p', description: 'd', type: 'ai', dependencies: [], sliceType: 'HITL', autonomy: 'HITL',
        subtasks: [{ id: 'child', order: 1, title: 'c', description: 'd', type: 'ai' }],
      }],
    });
    const child = parsePlanJson(raw, RUNNERS)[0].subtasks[0];
    expect(child.sliceType).toBe('HITL');
    expect(child.autonomy).toBe('HITL');
  });

  it('an explicit subtask classification beats the inherited one', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'p', description: 'd', type: 'ai', dependencies: [], sliceType: 'HITL', autonomy: 'HITL',
        subtasks: [{ id: 'child', order: 1, title: 'c', description: 'd', type: 'ai', sliceType: 'AFK', autonomy: 'AFK' }],
      }],
    });
    const child = parsePlanJson(raw, RUNNERS)[0].subtasks[0];
    expect(child.sliceType).toBe('AFK');
    expect(child.autonomy).toBe('AFK');
  });

  // A human gate is never inherited into existence: a user sub-step must say so.
  it('still rejects a bare user subtask, and names where it lives', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'Parent slice', description: 'd', type: 'ai', dependencies: [], sliceType: 'AFK', autonomy: 'AFK',
        subtasks: [{ id: 'child', order: 1, title: 'Manual check', description: 'd', type: 'user' }],
      }],
    });
    expect(() => parsePlanJson(raw, RUNNERS)).toThrow(/subtask "Manual check" of "Parent slice".*missing sliceType/);
  });

  it('parses autonomy field on ai tasks', () => {
    const tasks = parsePlanJson(onePlan({ autonomy: 'AFK' }), RUNNERS);
    expect(tasks[0].autonomy).toBe('AFK');
  });

  it('ignores autonomy on user tasks', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'u', order: 1, title: 't', description: 'd', type: 'user', dependencies: [], subtasks: [], sliceType: 'HITL', autonomy: 'AFK' }],
    });
    const t = parsePlanJson(raw, RUNNERS)[0];
    expect(t.autonomy).toBeUndefined();
  });

  it('parses sliceType field', () => {
    const tasks = parsePlanJson(onePlan({ sliceType: 'HITL' }), RUNNERS);
    expect(tasks[0].sliceType).toBe('HITL');
  });

  it('parses userStoriesCovered as string array', () => {
    const tasks = parsePlanJson(onePlan({ userStoriesCovered: ['US-1', 'US-2'] }), RUNNERS);
    expect(tasks[0].userStoriesCovered).toEqual(['US-1', 'US-2']);
  });

  it('defaults missing userStoriesCovered to undefined', () => {
    const tasks = parsePlanJson(onePlan(), RUNNERS);
    expect(tasks[0].userStoriesCovered).toBeUndefined();
  });

  it('rejects tasks missing sliceType', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 'NoSlice', description: 'd', type: 'ai', dependencies: [], subtasks: [], autonomy: 'AFK' }],
    });
    expect(() => parsePlanJson(raw, RUNNERS)).toThrow(/missing sliceType/);
  });

  it('rejects AI tasks missing autonomy', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 'NoAuto', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK' }],
    });
    expect(() => parsePlanJson(raw, RUNNERS)).toThrow(/missing autonomy/);
  });

  it('rejects AFK tasks that have userSteps', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 'BadAFK', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK', userSteps: [{ order: 1, instruction: 'Click', completed: false }] }],
    });
    expect(() => parsePlanJson(raw, RUNNERS)).toThrow(/AFK.*userSteps/);
  });

  it('rejects user tasks with non-HITL sliceType', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 'BadUser', description: 'd', type: 'user', dependencies: [], subtasks: [], sliceType: 'AFK' }],
    });
    expect(() => parsePlanJson(raw, RUNNERS)).toThrow(/User task.*HITL/);
  });
});

describe('parsePartialPlan', () => {
  it('returns no tasks before any task object has started', () => {
    expect(parsePartialPlan('')).toEqual([]);
    expect(parsePartialPlan('{"tas')).toEqual([]);
    expect(parsePartialPlan('{"tasks": [')).toEqual([]);
  });

  it('marks a task whose object has closed as complete', () => {
    const partial = '{"tasks":[{"id":"t1","title":"First task"}';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'First task', status: 'complete' },
    ]);
  });

  it('reports one complete task and one still streaming', () => {
    const partial = '{"tasks":[{"id":"t1","title":"First task"},{"id":"t2","title":"Second ta';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'First task', status: 'complete' },
      { title: 'Second ta', status: 'streaming' },
    ]);
  });

  it('marks every task complete once all objects have closed', () => {
    const partial = '{"tasks":[{"title":"A"},{"title":"B"},{"title":"C"}]}';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'A', status: 'complete' },
      { title: 'B', status: 'complete' },
      { title: 'C', status: 'complete' },
    ]);
  });

  it('treats an opened task object without a title yet as a streaming row', () => {
    const partial = '{"tasks":[{"title":"A"},{"id":"t2"';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'A', status: 'complete' },
      { title: '', status: 'streaming' },
    ]);
  });

  it('ignores leading reasoning noise and fences', () => {
    const partial = '<think>planning {x}</think>\n```json\n{"tasks":[{"title":"A"}';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'A', status: 'complete' },
    ]);
  });

  it('surfaces the model label and read-only mark of a completed task for chips', () => {
    const partial = '{"tasks":[{"title":"A","assignedModel":{"modelLabel":"Opus 4.8"},"readOnly":true}';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'A', status: 'complete', model: 'Opus 4.8', readOnly: true },
    ]);
  });

  it('reads a row\'s chips from the task itself, not from its subtasks', () => {
    const partial = '{"tasks":[{"subtasks":[{"title":"Child","assignedModel":{"modelLabel":"Haiku"},"readOnly":true}],"title":"Parent"}';
    expect(parsePartialPlan(partial)).toEqual([{ title: 'Parent', status: 'complete' }]);
  });

  it('omits model/mode while a task is still streaming them', () => {
    const partial = '{"tasks":[{"title":"A","assignedM';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'A', status: 'streaming' },
    ]);
  });
});

describe('looksLikePlanAttempt', () => {
  it('is true for a balanced tasks-keyed object that fails validation', () => {
    expect(looksLikePlanAttempt('{"tasks":[{"title":"no sliceType"}]}')).toBe(true);
  });

  it('is true for plan JSON cut off mid-stream', () => {
    expect(looksLikePlanAttempt(onePlan().slice(0, onePlan().length - 5))).toBe(true);
  });

  it('is false for prose that merely mentions "tasks"', () => {
    expect(looksLikePlanAttempt('I will emit a "tasks" array once you confirm the outline.')).toBe(false);
  });

  it('is false for plain prose', () => {
    expect(looksLikePlanAttempt('What database do you want to use?')).toBe(false);
  });
});

describe('extractJsonObject', () => {
  it('strips json code fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts a balanced object from surrounding prose', () => {
    expect(extractJsonObject('before {"a":{"b":2}} after')).toBe('{"a":{"b":2}}');
  });

  it('does not stop on a closing brace inside a string', () => {
    expect(extractJsonObject('{"k":"a } b"}')).toBe('{"k":"a } b"}');
  });

  it('returns the fence-stripped text unchanged when there is no object', () => {
    expect(extractJsonObject('no braces here')).toBe('no braces here');
  });

  it('removes a <think> block before scanning for the object', () => {
    const raw = '<think>I will plan { this } carefully</think>\n{"tasks":[]}';
    expect(extractJsonObject(raw)).toBe('{"tasks":[]}');
  });

  it('prefers the object that contains a tasks key over an earlier object', () => {
    const raw = '{"note":"ignore me"} then the real one {"tasks":[{"id":"t1"}]}';
    expect(extractJsonObject(raw)).toBe('{"tasks":[{"id":"t1"}]}');
  });
});

describe('generatePlanWithRepair', () => {
  const validPlan = JSON.stringify({
    tasks: [{ id: 't1', order: 1, title: 't', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
  });
  const RUNNERS = ['claude-code'];

  it('returns the plan on the first valid attempt without a repair hint', async () => {
    const hints: (string | undefined)[] = [];
    const tasks = await generatePlanWithRepair(async (hint) => {
      hints.push(hint);
      return validPlan;
    }, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(hints).toEqual([undefined]);
  });

  it('retries with the repair instruction after an invalid first response', async () => {
    const hints: (string | undefined)[] = [];
    const tasks = await generatePlanWithRepair(async (hint) => {
      hints.push(hint);
      return hint === undefined ? 'sorry, here is some prose with no json' : validPlan;
    }, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(hints).toEqual([undefined, JSON_REPAIR_INSTRUCTION]);
  });

  it('recovers when a reasoning-polluted first attempt is followed by a clean retry', async () => {
    const polluted = '<think>I should plan { carefully } and consider {edge cases</think>\nLet me think more...';
    const tasks = await generatePlanWithRepair(async (hint) =>
      hint === undefined ? polluted : validPlan,
      RUNNERS,
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('t1');
  });

  it('throws the PlanParseError after exhausting all attempts', async () => {
    await expect(
      generatePlanWithRepair(async () => 'never valid', RUNNERS, 2)
    ).rejects.toBeInstanceOf(PlanParseError);
  });

  it('does not retry on a non-parse (e.g. transport) error', async () => {
    let calls = 0;
    await expect(
      generatePlanWithRepair(async () => {
        calls++;
        throw new Error('network down');
      }, RUNNERS)
    ).rejects.toThrow(/network down/);
    expect(calls).toBe(1);
  });
});


// --- Modes: the planner says read-only, Ordewell picks the mode (ADR-0031) ---

describe('autonomy level names', () => {
  it('labels the two levels', () => {
    expect(autonomyLevelLabel(true)).toBe('Full');
    expect(autonomyLevelLabel(false)).toBe('Guarded');
  });

  it.each([
    ['full', true], ['FULL', true], ['on', true],
    ['guarded', false], ['GUARDED', false], ['auto', false], ['off', false],
    ['maybe', null], ['', null], [undefined, null],
  ])('parses the level argument %s', (arg, expected) => {
    expect(parseAutonomyLevel(arg)).toBe(expected);
  });
});

describe('parsePlanJson modes', () => {
  const runnerModes = {
    'claude-code': [
      { id: 'default', label: 'Ask before edits', description: 'asks' },
      { id: 'auto', label: 'Auto', description: 'classifier', safe: true },
      { id: 'acceptEdits', label: 'Edit automatically', description: 'edits' },
      { id: 'plan', label: 'Plan mode', description: 'read-only', readOnly: true },
      { id: 'bypassPermissions', label: 'Bypass permissions', description: 'skips prompts', autonomous: true },
    ],
    codex: [
      { id: 'agent', label: 'Agent', description: 'workspace-write', safe: true },
      { id: 'plan', label: 'Plan', description: 'read-only', readOnly: true },
      { id: 'fullAccess', label: 'Full access', description: 'no sandbox', autonomous: true },
    ],
    custom: [
      { id: 'write', label: 'Write', description: 'writes', autonomous: true, safe: true },
    ],
  };
  const runners = ['claude-code', 'codex', 'custom'];
  const planWith = (fields: Record<string, unknown>, runner = 'claude-code') => onePlan({ assignedRunner: runner, ...fields });

  it('gives each AI task its runner\'s mode for the level', () => {
    expect(parsePlanJson(planWith({}), runners, runnerModes, true)[0].taskMode).toBe('bypassPermissions');
    expect(parsePlanJson(planWith({}), runners, runnerModes, false)[0].taskMode).toBe('auto');
    expect(parsePlanJson(planWith({}, 'codex'), runners, runnerModes, true)[0].taskMode).toBe('fullAccess');
    expect(parsePlanJson(planWith({}, 'codex'), runners, runnerModes, false)[0].taskMode).toBe('agent');
  });

  it('gives a read-only task its runner\'s read-only mode', () => {
    expect(parsePlanJson(planWith({ readOnly: true }), runners, runnerModes, true)[0].taskMode).toBe('plan');
    expect(parsePlanJson(planWith({ readOnly: true }, 'codex'), runners, runnerModes, false)[0].taskMode).toBe('plan');
  });

  it('ignores a mode the planner names, and says so', () => {
    const raw = JSON.parse(planWith({ taskMode: 'bypassPermissions' })) as { tasks: unknown[] };
    const result = validatePlanTasks(raw, runners, runnerModes, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks[0].taskMode).toBe('auto');
    expect(result.warnings?.join(' ')).toContain('taskMode');
    expect(parsePlanJson(planWith({ taskMode: 'plan' }), runners, runnerModes, true)[0].taskMode).toBe('bypassPermissions');
  });

  it('refuses a read-only task on a runner without a read-only mode', () => {
    const raw = JSON.parse(planWith({ readOnly: true }, 'custom')) as { tasks: unknown[] };
    const result = validatePlanTasks(raw, runners, runnerModes, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ taskId: 't1', field: 'readOnly' });
    expect(result.errors[0].message).toContain('claude-code, codex');
    expect(() => parsePlanJson(planWith({ readOnly: true }, 'custom'), runners, runnerModes)).toThrow(PlanParseError);
  });

  it('decides subtasks the same way', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'p', description: 'd', type: 'ai', dependencies: [], sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code',
        subtasks: [{ id: 'child', order: 1, title: 'c', description: 'd', type: 'ai', dependencies: [], readOnly: true, assignedRunner: 'claude-code', subtasks: [] }],
      }],
    });
    const [parent] = parsePlanJson(raw, runners, runnerModes, false);
    expect(parent.taskMode).toBe('auto');
    expect(parent.subtasks[0].taskMode).toBe('plan');
  });

  it('passes a task\'s read-only down to its subtasks unless a subtask says otherwise', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'p', description: 'd', type: 'ai', dependencies: [], sliceType: 'AFK', autonomy: 'AFK', readOnly: true, assignedRunner: 'claude-code',
        subtasks: [
          { id: 'read', order: 1, title: 'r', description: 'd', type: 'ai', dependencies: [], assignedRunner: 'codex', subtasks: [] },
          { id: 'write', order: 2, title: 'w', description: 'd', type: 'ai', dependencies: [], readOnly: false, assignedRunner: 'claude-code', subtasks: [] },
        ],
      }],
    });
    const [parent] = parsePlanJson(raw, runners, runnerModes, false);
    expect(parent.subtasks.map((s) => s.taskMode)).toEqual(['plan', 'auto']);
  });

  it('falls back to positional last non-plan when no level tags exist', () => {
    const untagged = { 'claude-code': [{ id: 'default', label: 'Ask', description: 'asks' }, { id: 'plan', label: 'Plan', description: 'read-only' }, { id: 'bypassPermissions', label: 'Bypass', description: 'skips' }] };
    expect(parsePlanJson(planWith({}), ['claude-code'], untagged, false)[0].taskMode).toBe('bypassPermissions');
  });

  it('collapses to build/plan when no runner modes are known', () => {
    expect(parsePlanJson(onePlan(), ['claude-code'])[0].taskMode).toBe('build');
    expect(parsePlanJson(onePlan({ readOnly: true }), ['claude-code'])[0].taskMode).toBe('plan');
    expect(parsePlanJson(onePlan({ taskMode: 'plan' }), ['claude-code'])[0].taskMode).toBe('build');
  });
});

describe('the planner prompt asks for read-only, never a mode', () => {
  const runnerModes = {
    'claude-code': [
      { id: 'auto', label: 'Auto', description: 'classifier', safe: true },
      { id: 'acceptEdits', label: 'Edit', description: 'edits' },
      { id: 'plan', label: 'Plan', description: 'read-only', readOnly: true },
      { id: 'bypassPermissions', label: 'Bypass', description: 'skips prompts', autonomous: true },
    ],
  };

  it.each([true, false])('names no mode id at either level (Full=%s)', (autonomousDefault) => {
    const prompt = buildPlanWithResults('g', '', '', {}, ['claude-code'], runnerModes, modes({ autonomousDefault }));
    expect(prompt).toContain('"readOnly"');
    expect(prompt).not.toContain('"taskMode"');
    for (const id of ['bypassPermissions', 'acceptEdits', '"auto"']) expect(prompt).not.toContain(id);
  });

  it('names the runners that can take a read-only task', () => {
    const prompt = buildResearchPrompt('g', '', {}, ['claude-code', 'custom'], { ...runnerModes, custom: [{ id: 'write', label: 'W', description: 'w' }] }, modes());
    const line = prompt.split('\n').find((l) => l.startsWith('Runners with a read-only mode')) ?? '';
    expect(line).toContain('claude-code');
    expect(line).not.toContain('custom');
  });

  it.each([true, false])('shows readOnly as false in the task template, so a copied example writes (Full=%s)', (autonomousDefault) => {
    const prompt = buildPlanWithResults('g', '', '', {}, ['claude-code'], runnerModes, modes({ autonomousDefault }));
    expect(prompt).toContain('"readOnly": false');
    expect(prompt).not.toContain('"readOnly": true,');
  });
});
