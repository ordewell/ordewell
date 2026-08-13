import { describe, it, expect } from 'vitest';
import { applyTaskOps, parseTaskOpsJson, textHasTaskOps, canMergeTasks, canSplitTask } from '../TaskOps';
import { PlanParseError } from '../JsonExtractor';
import { createTask, type Task } from '../../models/Task';

function samplePlan(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' }),
    createTask({ id: 'b', order: 2, title: 'Build', prompt: 'build', dependencies: ['a'], assignedRunner: 'claude-code' }),
    createTask({ id: 'c', order: 3, title: 'Test', prompt: 'test', dependencies: ['b'], assignedRunner: 'claude-code' }),
  ];
}

describe('parseTaskOpsJson', () => {
  it('parses ops from a reply with prose around the JSON', () => {
    const ops = parseTaskOpsJson('Sure, here you go:\n{"taskOps":[{"op":"remove","taskId":"#2"}]}\nDone.');
    expect(ops).toEqual([{ op: 'remove', taskId: '#2' }]);
  });

  it('rejects an empty or missing taskOps array', () => {
    expect(() => parseTaskOpsJson('{"taskOps":[]}')).toThrow(PlanParseError);
    expect(() => parseTaskOpsJson('{"other":1}')).toThrow(PlanParseError);
  });

  it('textHasTaskOps detects the key', () => {
    expect(textHasTaskOps('{"taskOps":[...]}')).toBe(true);
    expect(textHasTaskOps('{"tasks":[...]}')).toBe(false);
  });

  it('finds the ops object even when a tasks-keyed object appears in the same reply', () => {
    // A schema echo like {"tasks":[...]} must not shadow the actual ops.
    const reply = 'The plan format is {"tasks":[{"id":"x","title":"example"}]} but I only need an edit:\n{"taskOps":[{"op":"remove","taskId":"#2"}]}';
    expect(parseTaskOpsJson(reply)).toEqual([{ op: 'remove', taskId: '#2' }]);
  });

  it('prefers the LAST ops object when the reply carries several', () => {
    const reply = 'Draft: {"taskOps":[{"op":"remove","taskId":"#1"}]}\nFinal: {"taskOps":[{"op":"remove","taskId":"#3"}]}';
    expect(parseTaskOpsJson(reply)).toEqual([{ op: 'remove', taskId: '#3' }]);
  });
});

describe('applyTaskOps', () => {
  it('updates a task referenced by #order', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[1].title).toBe('Build v2');
    expect(res.summary[0]).toContain('Build');
  });

  it('adds a task with dependencies resolved from order refs', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Docs', dependencies: ['#3'] } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(4);
    const added = res.tasks[3];
    expect(added.dependencies).toEqual(['c']);
    expect(added.assignedRunner).toBe('claude-code');
    expect(added.id).toBeTruthy();
  });

  it('removes a task and cleans up dependent references', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'remove', taskId: 'b' }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    expect(res.tasks.find((t) => t.title === 'Test')!.dependencies).toEqual([]);
  });

  it('rejects a dependency cycle and leaves the plan untouched', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [{ op: 'update', taskId: 'a', changes: { dependencies: ['c'] } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/cycle|ordered before/i);
    expect(res.tasks).toBe(original);
  });

  it('rejects unknown dependency references', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { dependencies: ['nope'] } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('unknown dependencies');
  });

  // The planner never gets to reach into a task that is running or already
  // finished — the user's own delete of a finished task is allowed, but that is
  // a decision they make on the direct path, not one the model may take here.
  it('refuses to modify or remove a running or completed task', () => {
    const plan = samplePlan();
    plan[0].status = 'in_progress';
    plan[1].status = 'completed';
    for (const [op, taskId, why] of [
      ['update', 'a', /running/],
      ['remove', 'a', /running/],
      ['update', 'b', /completed/],
      ['remove', 'b', /completed/],
    ] as const) {
      const res = applyTaskOps(
        plan,
        [op === 'update' ? { op, taskId, changes: { title: 'x' } } : { op, taskId }],
        ['claude-code'],
      );
      expect(res.ok).toBe(false);
      expect(res.errors[0]).toMatch(why);
      expect(res.tasks).toBe(plan);
    }
  });

  it('resolves every ref against the pre-batch plan, not the mid-batch renumbered one', () => {
    // a(1) b(2) c(3) d(4): remove #2 first, so naive re-numbering would make
    // "#4" (originally d) land on c. The planner meant the #4 it saw before
    // the batch started — d — regardless of what removal did to the numbering.
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'd', order: 4, title: 'D', prompt: 'p', assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [
      { op: 'remove', taskId: '#2' },
      { op: 'update', taskId: '#4', changes: { title: 'D renamed' } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.find((t) => t.id === 'd')!.title).toBe('D renamed');
    expect(res.tasks.find((t) => t.id === 'c')!.title).toBe('C');
  });

  it('is atomic: a later invalid op rolls back earlier valid ones', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [
      { op: 'update', taskId: 'a', changes: { title: 'renamed' } },
      { op: 'remove', taskId: 'does-not-exist' },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.tasks).toBe(original);
    expect(original[0].title).toBe('Setup');
  });

  it('reorders tasks while respecting dependencies', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p' }),
    ];
    const ok = applyTaskOps(plan, [{ op: 'reorder', taskIds: ['#3', '#1', '#2'] }], ['claude-code']);
    expect(ok.ok).toBe(true);
    expect(ok.tasks.map((t) => t.title)).toEqual(['C', 'A', 'B']);

    // A reorder that contradicts the graph is not a refusal either: the repair
    // pass runs on whatever the batch produced, so the chain a -> b -> c comes
    // back in the only order its dependencies allow.
    const chain = applyTaskOps(samplePlan(), [{ op: 'reorder', taskIds: ['#3', '#2', '#1'] }], ['claude-code']);
    expect(chain.ok).toBe(true);
    expect(chain.tasks.map((t) => t.title)).toEqual(['Setup', 'Build', 'Test']);
  });

  it('updates a task\'s description', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { description: 'a re-scoped description' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].description).toBe('a re-scoped description');
  });

  it('moves work between runners with a valid in-plan runner change', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'codex' } }], ['claude-code', 'codex']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].assignedRunner).toBe('codex');
  });

  it('applies a thinkingEffort change', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { thinkingEffort: 'high' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].thinkingEffort).toBe('high');
  });

  it('applies a standalone autonomy change, correcting HITL/AFK classification after the fact', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { autonomy: 'HITL' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].autonomy).toBe('HITL');
  });

  it('rejects a runner outside the plan runner set', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'aider' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('runner');
  });

  it('never lets the model change system-owned fields', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { status: 'completed', id: 'hax', title: 'ok' } as never },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].id).toBe('a');
    expect(res.tasks[0].status).toBe('pending');
    expect(res.tasks[0].title).toBe('ok');
  });

  describe('type coherence on AI <-> MAN flips', () => {
    // Missing content is refused, naming what is missing, so the repair loop
    // can feed it back — nothing about the human/AI task is invented.
    const cases: [Partial<Task>, RegExp][] = [
      [{ type: 'user' }, /user steps/i],
      [{ type: 'user', userSteps: [] }, /user steps/i],
      [{ type: 'ai' }, /prompt/i],
      [{ type: 'ai', prompt: '   ' }, /prompt/i],
    ];
    for (const [changes, why] of cases) {
      it(`refuses a flip to "${changes.type}" missing its required content`, () => {
        const plan = samplePlan();
        if (changes.type === 'ai') plan[0].type = 'user';
        const res = applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes }], ['claude-code']);
        expect(res.ok).toBe(false);
        expect(res.errors[0]).toMatch(why);
        expect(res.tasks).toBe(plan);
      });
    }

    it('flips AI to MAN when user steps are supplied, clearing the AI-only fields and naming them', () => {
      const plan = samplePlan();
      plan[0].assignedModel = { modelId: 'claude-code/opus', modelLabel: 'Opus' };
      plan[0].thinkingEffort = 'high';
      plan[0].autonomy = 'AFK';
      // taskMode defaults to 'build' via createTask, so it is already set.
      const res = applyTaskOps(plan, [{
        op: 'update', taskId: 'a',
        changes: { type: 'user', userSteps: [{ order: 1, instruction: 'flip the switch', completed: false }] },
      }], ['claude-code']);
      expect(res.ok).toBe(true);
      const updated = res.tasks[0];
      expect(updated.type).toBe('user');
      expect(updated.userSteps).toHaveLength(1);
      expect(updated.assignedModel).toBeUndefined();
      expect(updated.thinkingEffort).toBeUndefined();
      expect(updated.taskMode).toBeUndefined();
      expect(updated.autonomy).toBeUndefined();
      expect(res.summary[0]).toContain('cleared');
      expect(res.summary[0]).toContain('assignedModel');
      expect(res.summary[0]).toContain('taskMode');
    });

    it('flips MAN to AI when a prompt is supplied, clearing user steps and naming it', () => {
      const plan = samplePlan();
      plan[0].type = 'user';
      plan[0].userSteps = [{ order: 1, instruction: 'do the thing', completed: false }];
      const res = applyTaskOps(plan, [{
        op: 'update', taskId: 'a',
        changes: { type: 'ai', prompt: 'do the thing autonomously' },
      }], ['claude-code']);
      expect(res.ok).toBe(true);
      const updated = res.tasks[0];
      expect(updated.type).toBe('ai');
      expect(updated.prompt).toBe('do the thing autonomously');
      expect(updated.userSteps).toBeUndefined();
      expect(res.summary[0]).toContain('cleared userSteps');
    });

    it('does not require content or clear anything when the type is unchanged', () => {
      const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { type: 'ai', title: 'renamed' } }], ['claude-code']);
      expect(res.ok).toBe(true);
      expect(res.tasks[0].title).toBe('renamed');
      expect(res.summary[0]).not.toContain('cleared');
    });
  });
});

describe('applyTaskOps — rearm', () => {
  it('re-arms a failed task: pending, verdict and output summary cleared', () => {
    const plan = samplePlan();
    plan[0].status = 'failed';
    plan[0].verdict = { outcome: 'fail', reason: 'broke', checks: [], decidedAt: 'now' };
    plan[0].outputSummary = { reviewReason: 'broke', logTail: 'oops', capturedAt: 'now' };
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(true);
    const rearmed = res.tasks.find((t) => t.id === 'a')!;
    expect(rearmed.status).toBe('pending');
    expect(rearmed.verdict).toBeUndefined();
    expect(rearmed.outputSummary).toBeUndefined();
    expect(res.summary[0]).toContain('Re-armed');
  });

  it('re-arms a completed task the same way', () => {
    const plan = samplePlan();
    plan[0].status = 'completed';
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.find((t) => t.id === 'a')!.status).toBe('pending');
  });

  it('applies field changes in the same op that re-arms the task', () => {
    const plan = samplePlan();
    plan[0].status = 'failed';
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a', changes: { prompt: 'corrected prompt' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    const rearmed = res.tasks.find((t) => t.id === 'a')!;
    expect(rearmed.status).toBe('pending');
    expect(rearmed.prompt).toBe('corrected prompt');
  });

  it('releases dependents blocked behind the re-armed task', () => {
    const plan = samplePlan();
    plan[0].status = 'failed';
    plan[1].status = 'blocked'; // depends on 'a'
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.find((t) => t.id === 'b')!.status).toBe('pending');
  });

  it('refuses to re-arm a running task', () => {
    const plan = samplePlan();
    plan[0].status = 'in_progress';
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/running/);
    expect(res.tasks).toBe(plan);
  });

  it('does not expose status as a field the changes payload can set directly', () => {
    const plan = samplePlan();
    plan[0].status = 'failed';
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a', changes: { status: 'completed' } as unknown as Partial<Task> }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.find((t) => t.id === 'a')!.status).toBe('pending');
  });
});

describe('applyTaskOps — model and task-mode validity', () => {
  const CATALOG = {
    modelsByRunner: {
      'claude-code': [
        { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] },
        { modelId: 'claude-opus-4-5', modelLabel: 'Claude Opus 4.5', variants: [] },
      ],
    },
    runnerModes: {
      'claude-code': [
        { id: 'acceptEdits', label: 'Accept Edits', description: 'edit automatically' },
        { id: 'plan', label: 'Plan', description: 'read-only' },
      ],
    },
  };

  it('refuses an update to a model the runner does not offer, naming the runner', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'gpt-9-imaginary', modelLabel: 'GPT-9' } } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('claude-code');
    expect(res.errors[0]).toContain('gpt-9-imaginary');
  });

  it('refuses an update to a model excluded by the allowlist, on the same footing as an unoffered model', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-opus-4-5', modelLabel: 'Claude Opus 4.5' } } },
    ], ['claude-code'], { ...CATALOG, perRunnerAllowlist: { 'claude-code': ['claude-sonnet-4-5'] } });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/allowlist/i);
  });

  it('refuses an update to a task mode the runner does not have, naming the runner', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { taskMode: 'yolo' } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('claude-code');
    expect(res.errors[0]).toContain('yolo');
  });

  it('accepts a model the runner offers and within the allowlist', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' } } },
    ], ['claude-code'], { ...CATALOG, perRunnerAllowlist: { 'claude-code': ['claude-sonnet-4-5'] } });
    expect(res.ok).toBe(true);
  });

  it('accepts a valid task mode', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { taskMode: 'plan' } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].taskMode).toBe('plan');
  });

  it('refuses an added task with an invented model', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Docs', assignedModel: { modelId: 'gpt-9-imaginary', modelLabel: 'GPT-9' } } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('gpt-9-imaginary');
  });

  it('refuses an added task with an invalid task mode', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Docs', taskMode: 'yolo' } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('yolo');
  });

  it('runs no model/mode check when no catalog is supplied (backwards compatible)', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'anything-goes', modelLabel: 'Anything' } } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
  });

  // Thinking effort is an alias-resolution problem, not an invention problem
  // (clampThinkingEffort handles it downstream in coerceAssignments) — a
  // differently-spelled effort must never be refused here.
  it('never refuses on thinkingEffort spelling — that stays the clamp\'s job', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'not-a-real-effort' } } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(true);
  });
});

describe('applyTaskOps — batch handles', () => {
  it('lets a later op depend on a task an earlier add created in the same batch', () => {
    // Added tasks always land last, so the dependent must be the later add —
    // the realistic "add a prerequisite, then add a followup that needs it".
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Prereq', description: 'd', prompt: 'p' }, handle: 'h1' },
      { op: 'add', task: { title: 'Followup', description: 'd', prompt: 'p', dependencies: ['h1'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    const prereq = res.tasks.find((t) => t.title === 'Prereq')!;
    const followup = res.tasks.find((t) => t.title === 'Followup')!;
    expect(followup.dependencies).toEqual([prereq.id]);
    expect(prereq.order).toBeLessThan(followup.order);
  });

  it('lets a later op reference a merge handle', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Setup + Build' }, handle: 'combined' },
      { op: 'update', taskId: 'c', changes: { dependencies: ['combined'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    const merged = res.tasks.find((t) => t.title === 'Setup + Build')!;
    const c = res.tasks.find((t) => t.id === 'c')!;
    expect(c.dependencies).toEqual([merged.id]);
  });

  it('lets a later op reference a split handle (the tail part)', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'split', taskId: 'b', parts: [{ title: 'Build core' }, { title: 'Build UI' }], handle: 'built' },
      { op: 'add', task: { title: 'Docs', dependencies: ['built'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    const tail = res.tasks.find((t) => t.title === 'Build UI')!;
    const docs = res.tasks.find((t) => t.title === 'Docs')!;
    expect(docs.dependencies).toEqual([tail.id]);
  });

  it('refuses a handle that collides with an existing task reference', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Prereq' }, handle: 'a' }, // 'a' is an existing task id
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/collides/);
    expect(res.tasks).toHaveLength(3);
  });

  it('refuses a handle reused twice in the same batch', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [
      { op: 'add', task: { title: 'One' }, handle: 'dup' },
      { op: 'add', task: { title: 'Two' }, handle: 'dup' },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/already used/);
    expect(res.tasks).toBe(original);
  });

  it('refuses a forward reference to a handle defined later in the batch', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['h1'] } },
      { op: 'add', task: { title: 'Prereq' }, handle: 'h1' },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/defined later in this batch/);
    expect(res.tasks).toBe(original);
  });

  it('leaves the plan untouched when a handle-carrying batch is refused partway through', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [
      { op: 'add', task: { title: 'Prereq' }, handle: 'h1' },
      { op: 'update', taskId: 'nope', changes: { dependencies: ['h1'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.tasks).toBe(original);
    expect(original).toHaveLength(3);
  });
});

describe('applyTaskOps — merge', () => {
  it('collapses selected tasks into one and rewires dependents to the survivor', () => {
    const plan = samplePlan(); // a(1) -> b(2) -> c(3)
    const res = applyTaskOps(plan, [{
      op: 'merge', taskIds: ['a', 'b'],
      merged: { title: 'Setup + Build', description: 'combined', prompt: 'do both' },
    }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    const merged = res.tasks.find((t) => t.title === 'Setup + Build')!;
    expect(merged.dependencies).toEqual([]); // a had none, b had [a] which is merged away
    // c depended on b; b is gone, so c now depends on the survivor.
    const c = res.tasks.find((t) => t.title === 'Test')!;
    expect(c.dependencies).toEqual([merged.id]);
    expect(merged.order).toBeLessThan(c.order);
  });

  it('inherits assignedModel from the source tasks when the spec omits it', () => {
    const plan = samplePlan();
    plan[0].assignedModel = { modelId: 'claude-code/opus', modelLabel: 'Opus' };
    const res = applyTaskOps(plan, [{
      op: 'merge', taskIds: ['a', 'b'],
      merged: { title: 'Setup + Build' },
    }], ['claude-code']);
    expect(res.ok).toBe(true);
    const merged = res.tasks.find((t) => t.title === 'Setup + Build')!;
    expect(merged.assignedModel?.modelId).toBe('claude-code/opus');
  });

  it('rejects a merge with fewer than two tasks', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['a'], merged: { title: 'x' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/at least two/i);
  });

  it('rejects a merge whose merged spec has no title', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['a', 'b'], merged: {} }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/title/);
  });

  it('refuses to merge running or completed tasks', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'x' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/completed/);
  });

  it('inherits the union of dependencies when the merged tasks each depend on a distinct external task', () => {
    const plan = [
      createTask({ id: 'x', order: 1, title: 'X', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'y', order: 2, title: 'Y', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'a', order: 3, title: 'A', prompt: 'p', dependencies: ['x'], assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 4, title: 'B', prompt: 'p', dependencies: ['y'], assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'A + B' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    const merged = res.tasks.find((t) => t.title === 'A + B')!;
    expect(merged.dependencies.sort()).toEqual(['x', 'y']);
  });

  it('falls back to combined description/prompt when the spec omits them', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', description: 'desc-a', prompt: 'p-a', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', description: 'desc-b', prompt: 'p-b', assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    const merged = res.tasks.find((t) => t.title === 'AB')!;
    expect(merged.description).toContain('desc-a');
    expect(merged.description).toContain('desc-b');
    expect(merged.prompt).toContain('p-a');
    expect(merged.prompt).toContain('p-b');
  });
});

describe('applyTaskOps — split', () => {
  it('replaces one task with a chained sequence and rewires dependents to the tail', () => {
    const plan = samplePlan(); // a(1) -> b(2) -> c(3)
    const res = applyTaskOps(plan, [{
      op: 'split', taskId: 'b',
      parts: [
        { title: 'Build core', description: 'core', prompt: 'build core' },
        { title: 'Build UI', description: 'ui', prompt: 'build ui' },
      ],
    }], ['claude-code']);
    expect(res.ok).toBe(true);
    const parts = res.tasks.filter((t) => t.title.startsWith('Build'));
    expect(parts).toHaveLength(2);
    // First part inherits b's dependencies ([a]); second depends on first.
    expect(parts[0].dependencies).toEqual(['a']);
    expect(parts[1].dependencies).toEqual([parts[0].id]);
    // c depended on b; now depends on the last part.
    const c = res.tasks.find((t) => t.title === 'Test')!;
    expect(c.dependencies).toEqual([parts[1].id]);
  });

  it('rejects a split with fewer than two parts', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'only' }] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/at least two/i);
  });

  it('rejects a split part missing a title', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'x' }, {}] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/part 2.*title/i);
  });

  it('refuses to split a completed task', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    const res = applyTaskOps(plan, [{ op: 'split', taskId: 'b', parts: [{ title: 'x' }, { title: 'y' }] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/completed/);
  });
});

describe('applyTaskOps — order repair', () => {
  function independentPlan(): Task[] {
    return [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p', assignedRunner: 'claude-code' }),
    ];
  }

  it('repairs the order when a rewire puts a task before its new dependency', () => {
    // A now depends on C, so A must move behind it. B and C are untouched by
    // the rewire and keep their relative order.
    const res = applyTaskOps(independentPlan(), [
      { op: 'update', taskId: 'a', changes: { dependencies: ['#3'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.title)).toEqual(['B', 'C', 'A']);
    expect(res.tasks.map((t) => t.order)).toEqual([1, 2, 3]);
  });

  it('keeps a completed task in its slot and reshuffles around it', () => {
    // A(1) must move behind C(3), which frees slot 1 — but the completed B(2)
    // holds slot 2, so C fills the slot A vacated rather than B sliding up.
    const plan = independentPlan();
    plan[1].status = 'completed';
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['#3'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.title)).toEqual(['C', 'B', 'A']);
    expect(res.tasks[1].status).toBe('completed');
  });

  it('lands a newly added prerequisite ahead of its dependent in one batch', () => {
    // The add itself can only append; the dependent is rewired onto it by a
    // later op in the same batch, and the repair pulls it up front.
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Scaffold', description: 'd', prompt: 'p' }, handle: 'h1' },
      { op: 'update', taskId: '#1', changes: { dependencies: ['h1'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.title)).toEqual(['Scaffold', 'Setup', 'Build', 'Test']);
  });

  it('moves only what the graph demands, leaving unrelated tasks in order', () => {
    const plan = ['A', 'B', 'C', 'D', 'E'].map((title, i) => createTask({
      id: title.toLowerCase(), order: i + 1, title, prompt: 'p', assignedRunner: 'claude-code',
    }));
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: 'b', changes: { dependencies: ['#5'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.title)).toEqual(['A', 'C', 'D', 'E', 'B']);
  });

  it('names the reshuffle in the summary, with old and new positions', () => {
    const res = applyTaskOps(independentPlan(), [
      { op: 'update', taskId: 'a', changes: { dependencies: ['#3'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    const line = res.summary.find((s) => s.startsWith('Reordered'))!;
    expect(line).toBe('Reordered to keep dependencies first: "B" #2→#1, "C" #3→#2, "A" #1→#3');
  });

  it('leaves the summary free of a reshuffle line when nothing moved', () => {
    const res = applyTaskOps(independentPlan(), [
      { op: 'update', taskId: 'c', changes: { dependencies: ['#1'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.summary.some((s) => s.startsWith('Reordered'))).toBe(false);
  });

  it('refuses a batch that could only be repaired by moving a completed task', () => {
    // B is completed and depends on A. Sending A behind C would drag B along
    // with it — the one thing the repair may not do.
    const plan = independentPlan();
    plan[1].status = 'completed';
    plan[1].dependencies = ['a'];
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['#3'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toBe('"A" would have to run before "B", which is completed and cannot be moved');
    expect(res.tasks).toBe(plan);
  });

  it('refuses to park a task behind a running task that would have to slide up for it', () => {
    // C(3) is running and last, so nothing can be scheduled after it without
    // renumbering it — which is exactly what the repair refuses to do.
    const plan = independentPlan();
    plan[2].status = 'in_progress';
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: 'a', changes: { dependencies: ['#3'] } },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toBe('"A" would have to run after "C", which is running and cannot be moved');
    expect(res.tasks).toBe(plan);
  });
});

describe('canMergeTasks', () => {
  it('approves a simple consecutive chain merge', () => {
    expect(canMergeTasks(samplePlan(), ['a', 'b']).ok).toBe(true);
  });

  // The pre-flight and the applier must agree: order alone is no longer a
  // reason to refuse, since the applier repairs it.
  it('approves a merge that only needs a display-order repair', () => {
    // A(1) and B(2) are independent; C(3) depends on B. Merging A + C gives a
    // survivor at slot 1 that depends on B at slot 2 — no cycle, just a shuffle.
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ];
    expect(canMergeTasks(plan, ['a', 'c']).ok).toBe(true);

    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'c'], merged: { title: 'A + C' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks.map((t) => t.title)).toEqual(['B', 'A + C']);
  });

  it('rejects fewer than two ids', () => {
    expect(canMergeTasks(samplePlan(), ['a']).ok).toBe(false);
  });

  it('rejects a merge that would pull in a later dependency (ordering break)', () => {
    // a(1), b(2) depends on a, c(3) depends on a, d(4) depends on b.
    // Merging a + d: survivor (order 1) would depend on b (order 2) -> order violation.
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'd', order: 4, title: 'D', prompt: 'p', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ];
    const res = canMergeTasks(plan, ['a', 'd']);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ordering|cycle/i);
  });

  it('rejects merging a running task', () => {
    const plan = samplePlan();
    plan[0].status = 'in_progress';
    expect(canMergeTasks(plan, ['a', 'b']).ok).toBe(false);
  });
});

describe('canSplitTask', () => {
  it('approves a pending task', () => {
    expect(canSplitTask(samplePlan(), 'b').ok).toBe(true);
  });

  it('rejects a completed task', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    expect(canSplitTask(plan, 'b').ok).toBe(false);
  });

  it('rejects an unknown task', () => {
    expect(canSplitTask(samplePlan(), 'nope').ok).toBe(false);
  });
});
