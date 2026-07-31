import { describe, it, expect } from 'vitest';
import { parsePlanJson, looksLikePlanAttempt } from '../PlanValidator';
import { generatePlanWithRepair, JSON_REPAIR_INSTRUCTION } from '../PlanRepair';
import { extractJsonObject, PlanParseError } from '../JsonExtractor';
import { parsePartialPlan } from '../PartialPlanParser';
import { buildModeGuide } from '../ModeResolver';
import { buildResearchPrompt, buildPlanWithResults, buildModifyPlanPrompt } from '../PlanPrompts';

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

  it('defaults unknown task type to "ai"', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 'x', order: 1, title: 't', description: 'd', type: 'something-weird', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
    });
    expect(parsePlanJson(raw, RUNNERS)[0].type).toBe('ai');
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

  it('honours taskMode "plan"', () => {
    expect(parsePlanJson(onePlan({ taskMode: 'plan' }), RUNNERS)[0].taskMode).toBe('plan');
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
  // rejecting the whole plan for that killed real trials. Inheriting from the
  // parent invents nothing — an ai sub-step of an AFK slice is AFK.
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

  it('surfaces the model label and mode of a completed task for chips', () => {
    const partial = '{"tasks":[{"title":"A","assignedModel":{"modelLabel":"Opus 4.8"},"taskMode":"plan"}';
    expect(parsePartialPlan(partial)).toEqual([
      { title: 'A', status: 'complete', model: 'Opus 4.8', mode: 'plan' },
    ]);
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

// --- Dynamic mode selection ---

describe('buildModeGuide', () => {
  const claudeModes = [
    { id: 'default', label: 'Ask before edits', description: 'Standard mode: asks permission before editing files', safe: true },
    { id: 'acceptEdits', label: 'Edit automatically', description: 'Edits files without asking' },
    { id: 'plan', label: 'Plan mode', description: 'Read-only analysis' },
    { id: 'bypassPermissions', label: 'Auto mode', description: 'Skips all permission prompts', autonomous: true },
  ];
  const opencodeModes = [
    { id: 'build', label: 'Build', description: 'Full access agent', autonomous: true, safe: true },
    { id: 'plan', label: 'Plan', description: 'Read-only agent' },
  ];

  it('shows only autonomous-compatible modes for claude-code when toggle is ON, safe-only modes hidden', () => {
    const guide = buildModeGuide({ 'claude-code': claudeModes, 'opencode': opencodeModes }, true);
    expect(guide).toContain('AVAILABLE MODES PER RUNNER');
    // safe-only "default" is filtered out
    expect(guide).not.toContain('default (');
    // autonomous-tagged mode shown as DEFAULT
    expect(guide).toContain('bypassPermissions (DEFAULT)');
    // neutral untagged mode still listed
    expect(guide).toContain('acceptEdits (');
    // bypassPermissions listed before acceptEdits
    expect(guide.indexOf('bypassPermissions')).toBeLessThan(guide.indexOf('acceptEdits'));
  });

  it('shows only safe-compatible modes for claude-code when toggle is OFF, autonomous-only modes hidden', () => {
    const guide = buildModeGuide({ 'claude-code': claudeModes, 'opencode': opencodeModes }, false);
    const ccLine = guide.split('\n').find((l) => l.startsWith('- claude-code:'))!;
    const ocLine = guide.split('\n').find((l) => l.startsWith('- opencode:'))!;
    // autonomous-only "bypassPermissions" is filtered out
    expect(ccLine).not.toContain('bypassPermissions');
    // safe-tagged mode shown as DEFAULT
    expect(ccLine).toContain('default (DEFAULT)');
    // neutral untagged mode still listed
    expect(ccLine).toContain('acceptEdits (');
    // opencode.build wears both tags — visible under OFF too, annotated
    expect(ocLine).toContain('build (DEFAULT)');
  });

  it('omits plan modes from the guide listing', () => {
    const guide = buildModeGuide({ 'claude-code': claudeModes, 'opencode': opencodeModes }, true);
    const ccLine = guide.split('\n').find((l) => l.startsWith('- claude-code:'))!;
    const ocLine = guide.split('\n').find((l) => l.startsWith('- opencode:'))!;
    expect(ccLine).not.toContain('plan (');
    expect(ocLine).not.toContain('plan (');
  });

  it('returns empty string for empty input', () => {
    expect(buildModeGuide({})).toBe('');
  });

  it('skips runners with empty mode arrays', () => {
    const guide = buildModeGuide({ 'claude-code': claudeModes, 'empty-runner': [] });
    expect(guide).toContain('claude-code');
    expect(guide).not.toContain('empty-runner');
  });
});

describe('parsePlanJson with dynamic modes', () => {
  const claudeModes = {
    'claude-code': [
      { id: 'default', label: 'Ask before edits', description: 'Standard mode' },
      { id: 'acceptEdits', label: 'Edit automatically', description: 'Edits without asking' },
      { id: 'plan', label: 'Plan mode', description: 'Read-only' },
      { id: 'bypassPermissions', label: 'Auto mode', description: 'CI only' },
    ],
    'opencode': [
      { id: 'build', label: 'Build', description: 'Full access' },
      { id: 'plan', label: 'Plan', description: 'Read-only' },
    ],
  };

  const mixedRunners = ['claude-code', 'opencode'];

  const planWithMode = (mode: string, runner = 'claude-code') => JSON.stringify({
    tasks: [{
      id: 't1', order: 1, title: 'Test', description: 'd', type: 'ai',
      dependencies: [], subtasks: [],
      sliceType: 'AFK', autonomy: 'AFK',
      taskMode: mode, assignedRunner: runner,
    }],
  });

  it('accepts a valid mode from the manifest', () => {
    const tasks = parsePlanJson(planWithMode('acceptEdits'), ['claude-code'], claudeModes);
    expect(tasks[0].taskMode).toBe('acceptEdits');
  });

  it('accepts bypassPermissions mode from the manifest', () => {
    const tasks = parsePlanJson(planWithMode('bypassPermissions'), ['claude-code'], claudeModes);
    expect(tasks[0].taskMode).toBe('bypassPermissions');
  });

  it('accepts build mode for opencode', () => {
    const tasks = parsePlanJson(planWithMode('build', 'opencode'), mixedRunners, claudeModes);
    expect(tasks[0].taskMode).toBe('build');
  });

  it('accepts plan mode for any runner', () => {
    const tasks = parsePlanJson(planWithMode('plan'), ['claude-code'], claudeModes);
    expect(tasks[0].taskMode).toBe('plan');
  });

  it('preserves a valid plan emission even when the toggle is ON', () => {
    const tagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', safe: true },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
        { id: 'plan', label: 'Plan', description: 'read-only' },
      ],
    };
    const tasks = parsePlanJson(planWithMode('plan'), ['claude-code'], tagged, true);
    expect(tasks[0].taskMode).toBe('plan');
  });

  it('accepts legacy "build" mode for claude-code (backward compat)', () => {
    const tasks = parsePlanJson(planWithMode('build'), ['claude-code'], claudeModes);
    expect(tasks[0].taskMode).toBe('build');
  });

  it('falls back to most-autonomous non-plan mode for invalid mode', () => {
    const tasks = parsePlanJson(planWithMode('nonexistent'), ['claude-code'], claudeModes);
    expect(tasks[0].taskMode).toBe('bypassPermissions');
  });

  it('falls back to the autonomous-tagged mode for invalid emissions when toggle is ON', () => {
    const tagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', safe: true },
        { id: 'acceptEdits', label: 'Edit', description: 'edits' },
        { id: 'plan', label: 'Plan', description: 'read-only' },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
      ],
    };
    const tasks = parsePlanJson(planWithMode('garbage'), ['claude-code'], tagged, true);
    expect(tasks[0].taskMode).toBe('bypassPermissions');
  });

  it('falls back to the safe-tagged mode for invalid emissions when toggle is OFF', () => {
    const tagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', safe: true },
        { id: 'acceptEdits', label: 'Edit', description: 'edits' },
        { id: 'plan', label: 'Plan', description: 'read-only' },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
      ],
    };
    const tasks = parsePlanJson(planWithMode('garbage'), ['claude-code'], tagged, false);
    expect(tasks[0].taskMode).toBe('default');
  });

  it('overrides valid mode that conflicts with toggle: safe mode → autonomous when ON', () => {
    const tagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', safe: true },
        { id: 'acceptEdits', label: 'Edit', description: 'edits' },
        { id: 'plan', label: 'Plan', description: 'read-only' },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
      ],
    };
    expect(parsePlanJson(planWithMode('default'), ['claude-code'], tagged, true)[0].taskMode).toBe('bypassPermissions');
    expect(parsePlanJson(planWithMode('bypassPermissions'), ['claude-code'], tagged, false)[0].taskMode).toBe('default');
  });

  it('passes through untagged mode (acceptEdits) regardless of toggle', () => {
    const tagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', safe: true },
        { id: 'acceptEdits', label: 'Edit', description: 'edits' },
        { id: 'plan', label: 'Plan', description: 'read-only' },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
      ],
    };
    expect(parsePlanJson(planWithMode('acceptEdits'), ['claude-code'], tagged, true)[0].taskMode).toBe('acceptEdits');
    expect(parsePlanJson(planWithMode('acceptEdits'), ['claude-code'], tagged, false)[0].taskMode).toBe('acceptEdits');
  });

  it('passes through dual-tagged mode (build) regardless of toggle', () => {
    const dual = {
      'opencode': [
        { id: 'build', label: 'Build', description: 'full access', autonomous: true, safe: true },
        { id: 'plan', label: 'Plan', description: 'read-only' },
      ],
    };
    expect(parsePlanJson(planWithMode('build', 'opencode'), ['opencode'], dual, true)[0].taskMode).toBe('build');
    expect(parsePlanJson(planWithMode('build', 'opencode'), ['opencode'], dual, false)[0].taskMode).toBe('build');
  });

  it('passes through byPassPermissions when toggle is ON (no conflict)', () => {
    const tagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks', safe: true },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
        { id: 'plan', label: 'Plan', description: 'read-only' },
      ],
    };
    const tasks = parsePlanJson(planWithMode('bypassPermissions'), ['claude-code'], tagged, true);
    expect(tasks[0].taskMode).toBe('bypassPermissions');
  });

  it('falls back to most-autonomous non-plan mode for opencode invalid mode', () => {
    const tasks = parsePlanJson(planWithMode('nonexistent', 'opencode'), mixedRunners, claudeModes);
    expect(tasks[0].taskMode).toBe('build');
  });

  it('defaults to build when no taskMode is specified and no modes info available', () => {
    const raw = JSON.stringify({
      tasks: [{ id: 't1', order: 1, title: 'T', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
    });
    const tasks = parsePlanJson(raw, ['claude-code']);
    expect(tasks[0].taskMode).toBe('build');
  });

  it('validates modes when runnerModes is partially provided', () => {
    const partialModes = { 'claude-code': claudeModes['claude-code'] };
    const tasks = parsePlanJson(planWithMode('acceptEdits'), ['claude-code'], partialModes);
    expect(tasks[0].taskMode).toBe('acceptEdits');
  });

  it('passes through mode when runner has no modes defined', () => {
    const tasks = parsePlanJson(planWithMode('some-mode', 'unknown-runner'), ['unknown-runner'], claudeModes);
    expect(tasks[0].taskMode).toBe('some-mode');
  });

  it('works without runnerModes (backward compat, collapses to build/plan as before)', () => {
    const t1 = parsePlanJson(planWithMode('plan'), ['claude-code']);
    expect(t1[0].taskMode).toBe('plan');
    const t2 = parsePlanJson(planWithMode('anything'), ['claude-code']);
    expect(t2[0].taskMode).toBe('build');
  });

  it('validates mode in subtasks too', () => {
    const raw = JSON.stringify({
      tasks: [{
        id: 'parent', order: 1, title: 'p', description: 'd', type: 'ai', dependencies: [], sliceType: 'AFK', autonomy: 'AFK',
        subtasks: [{ id: 'child', order: 1, title: 'c', description: 'd', type: 'ai', dependencies: [],
          taskMode: 'nonexistent', assignedRunner: 'claude-code', subtasks: [], sliceType: 'AFK', autonomy: 'AFK' }],
      }],
    });
    const tasks = parsePlanJson(raw, ['claude-code'], claudeModes);
    expect(tasks[0].subtasks[0].taskMode).toBe('bypassPermissions');
  });
});

describe('prompt contains dynamic mode guide', () => {
  const taggedModes = {
    'claude-code': [
      { id: 'default', label: 'Ask', description: 'asks', safe: true },
      { id: 'acceptEdits', label: 'Edit', description: 'edits' },
      { id: 'plan', label: 'Plan', description: 'read-only' },
      { id: 'bypassPermissions', label: 'Auto', description: 'skips prompts', autonomous: true },
    ],
  };

  it('shows autonomous modes and hides safe-only mode in prompt when toggle is ON', () => {
    const prompt = buildResearchPrompt('g', '', {}, ['claude-code'], taggedModes, modes({ autonomousDefault: true }));
    expect(prompt).toContain('bypassPermissions (DEFAULT)');
    expect(prompt).toContain('acceptEdits');
    // safe-only mode is filtered out entirely
    expect(prompt).not.toContain('default (');
  });

  it('shows safe modes and hides autonomous-only mode in prompt when toggle is OFF', () => {
    const prompt = buildResearchPrompt('g', '', {}, ['claude-code'], taggedModes, modes({ autonomousDefault: false }));
    expect(prompt).toContain('default (DEFAULT)');
    expect(prompt).toContain('acceptEdits');
    // autonomous-only mode is filtered out entirely
    expect(prompt).not.toContain('bypassPermissions');
  });

  it('lists only compatible MODE_EXAMPLES when toggle is ON', () => {
    const prompt = buildPlanWithResults('g', '', '', {}, ['claude-code'], taggedModes, modes({ autonomousDefault: true }));
    const examplesLine = prompt.split('\n').find((l) => l.includes('"taskMode"')) ?? '';
    // safe-only "default" is filtered out of examples
    expect(examplesLine).not.toContain('default');
    expect(examplesLine).toContain('bypassPermissions');
    expect(examplesLine).toContain('acceptEdits');
  });

  it('lists only compatible MODE_EXAMPLES when toggle is OFF', () => {
    const prompt = buildPlanWithResults('g', '', '', {}, ['claude-code'], taggedModes, modes({ autonomousDefault: false }));
    const examplesLine = prompt.split('\n').find((l) => l.includes('"taskMode"')) ?? '';
    // autonomous-only "bypassPermissions" is filtered out of examples
    expect(examplesLine).not.toContain('bypassPermissions');
    expect(examplesLine).toContain('default');
    expect(examplesLine).toContain('acceptEdits');
  });

  it('omits plan from the guide in buildModifyPlanPrompt too', () => {
    const existingPlan = { tasks: [], generatedAt: '', status: 'draft' as const, runners: ['claude-code' as const], lastUpdated: '' };
    const prompt = buildModifyPlanPrompt(existingPlan, '', {}, undefined, taggedModes, true);
    const guideLine = prompt.split('\n').find((l) => l.startsWith('- claude-code:')) ?? '';
    expect(guideLine).not.toContain('plan (');
  });
});

describe('resolveTaskMode degradation', () => {
  it('falls back to positional last non-plan when no autonomous/safe tags exist (T8)', () => {
    const untagged = {
      'claude-code': [
        { id: 'default', label: 'Ask', description: 'asks' },
        { id: 'acceptEdits', label: 'Edit', description: 'edits' },
        { id: 'plan', label: 'Plan', description: 'read-only' },
        { id: 'bypassPermissions', label: 'Auto', description: 'skips' },
      ],
    };
    const planWithMode = (mode: string) => JSON.stringify({
      tasks: [{ id: 't1', order: 1, title: 'T', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK', taskMode: mode, assignedRunner: 'claude-code' }],
    });
    // ON with no tags: positional last non-plan → bypassPermissions
    expect(parsePlanJson(planWithMode('garbage'), ['claude-code'], untagged, true)[0].taskMode).toBe('bypassPermissions');
    // OFF with no tags: positional last non-plan → bypassPermissions (same — tags drive selection)
    expect(parsePlanJson(planWithMode('garbage'), ['claude-code'], untagged, false)[0].taskMode).toBe('bypassPermissions');
  });

  it('collapses to build/plan when no runnerModes info is available (T9, backward compat)', () => {
    const planWithMode = (mode: string | undefined) => JSON.stringify({
      tasks: [{ id: 't1', order: 1, title: 'T', description: 'd', type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK', ...(mode !== undefined ? { taskMode: mode } : {}) }],
    });
    expect(parsePlanJson(planWithMode('plan'), ['claude-code'])[0].taskMode).toBe('plan');
    expect(parsePlanJson(planWithMode('anything'), ['claude-code'])[0].taskMode).toBe('build');
    expect(parsePlanJson(planWithMode(undefined), ['claude-code'])[0].taskMode).toBe('build');
  });
});
