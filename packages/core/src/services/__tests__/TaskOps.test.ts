import { describe, it, expect } from 'vitest';
import { applyTaskOps, parseTaskOpsJson, textHasTaskOps, type TaskOp } from '../TaskOps';
import { resolveAssignment } from '../TaskAssignment';
import { blockingFailures } from '../blocking';
import { validatePlanTasks } from '../PlanValidator';
import { PlanParseError } from '../JsonExtractor';
import { PlanStore } from '../PlanStore';
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
  it('refuses a planner self-dependency rather than silently dropping it', () => {
    const plan = samplePlan();
    const result = applyTaskOps(plan, [
      { op: 'update', taskId: '#2', changes: { dependencies: ['#2'] } },
    ], ['claude-code']);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cycle|itself/);
    expect(result.tasks).toBe(plan);
  });

  it('updates a task referenced by #order', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[1].title).toBe('Build v2');
    expect(res.summary[0]).toContain('Build');
  });

  it('reads #N as top-level task N, and a subtask by its dotted label, once a task has subtasks', () => {
    const plan = samplePlan();
    plan[0].subtasks = [
      createTask({ id: 'a1', order: 1, title: 'Config', assignedRunner: 'claude-code' }),
      createTask({ id: 'a2', order: 2, title: 'Seed', assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: '#2', changes: { title: 'Build v2' } },
      { op: 'update', taskId: '#1.2', changes: { title: 'Seed v2' } },
      { op: 'add', task: { title: 'Docs', dependencies: ['#2'] } },
    ], ['claude-code']);
    expect(res.errors).toEqual([]);
    expect(res.tasks[1].title).toBe('Build v2');
    expect(res.tasks[0].subtasks[1].title).toBe('Seed v2');
    expect(res.tasks[3].dependencies).toEqual(['b']);
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

  // A task waiting at a checkpoint or for input still has its runner live,
  // so reshaping it would run the same work twice.
  it('refuses to reshape a task whose runner waits at a checkpoint or for input', () => {
    for (const awaitingReason of ['checkpoint', 'input'] as const) {
      const plan = samplePlan();
      plan[0] = { ...plan[0], status: 'awaiting_user', awaitingReason };
      const ops: TaskOp[] = [
        { op: 'remove', taskId: 'a' },
        { op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Merged', prompt: 'do both' } },
        { op: 'split', taskId: 'a', parts: [{ title: 'One', prompt: 'p' }, { title: 'Two', prompt: 'p' }] },
      ];
      for (const op of ops) {
        const res = applyTaskOps(plan, [op], ['claude-code']);
        expect(res.ok, `${op.op} at ${awaitingReason}`).toBe(false);
        expect(res.errors[0]).toMatch(/"Setup" is running/);
        expect(res.tasks).toBe(plan);
      }
      expect(applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { title: 'x' } }], ['claude-code']).ok).toBe(true);
    }
  });

  it('keeps a task waiting at a checkpoint in its slot, as a running one', () => {
    const plan = samplePlan().map((t) => ({ ...t, dependencies: [] }));
    plan[2] = { ...plan[2], status: 'awaiting_user', awaitingReason: 'checkpoint' };
    const res = applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { dependencies: ['#3'] } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toBe('"Setup" would have to run after "Test", which is running and cannot be moved');
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

  it('applies a thinkingEffort change to the assigned model, the one place the effort lives', () => {
    const plan = samplePlan();
    plan[0].assignedModel = { modelId: 'opus', modelLabel: 'Opus' };
    const res = applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { thinkingEffort: 'high' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].assignedModel).toEqual({ modelId: 'opus', modelLabel: 'Opus', thinkingEffort: 'high' });
    expect(res.tasks[0]).not.toHaveProperty('thinkingEffort');
  });

  it('refuses a thinkingEffort change on a task with no model to carry it', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { thinkingEffort: 'high' } }], ['claude-code']);
    expect(res.errors).toEqual(['op 1 (update): "thinkingEffort" is the assigned model\'s — set "assignedModel" with it']);
  });

  it('applies a standalone autonomy change, correcting HITL/AFK classification after the fact', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { autonomy: 'HITL' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].autonomy).toBe('HITL');
  });

  it('holds the plan to its rules once, on the batch\'s final state: a later op may complete an earlier one', () => {
    const plan = samplePlan();
    plan[0].type = 'user';
    plan[0].userSteps = [{ order: 1, instruction: 'do the thing', completed: false }];
    plan[0].autonomy = undefined;
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: 'a', changes: { autonomy: 'AFK' } },
      { op: 'update', taskId: 'a', changes: { type: 'ai', prompt: 'do the thing autonomously' } },
    ], ['claude-code']);
    expect(res.errors).toEqual([]);
    expect(res.tasks[0]).toMatchObject({ type: 'ai', autonomy: 'AFK' });
    expect(res.tasks[0].userSteps).toBeUndefined();
  });

  it('names the op that broke a rule the batch ends in breach of', () => {
    const plan = samplePlan();
    plan[0].type = 'user';
    plan[0].userSteps = [{ order: 1, instruction: 'do the thing', completed: false }];
    plan[0].autonomy = undefined;
    const res = applyTaskOps(plan, [
      { op: 'update', taskId: 'a', changes: { autonomy: 'AFK' } },
      { op: 'update', taskId: 'b', changes: { title: 'Build v2' } },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([expect.stringMatching(/^op 1 \(update\): .*autonomy "AFK" but contains userSteps/)]);
  });

  it('lets a task whose runner was disabled since be retitled: a standing breach is matched by task and rule, not by wording', () => {
    const plan = samplePlan();
    plan[0].assignedRunner = 'codex';
    const res = applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { title: 'Setup v2' } }], ['claude-code']);
    expect(res.errors).toEqual([]);
    expect(res.tasks[0].title).toBe('Setup v2');
  });

  it('refuses a rule broken on a task whose title is already in breach of the same rule elsewhere', () => {
    const plan = samplePlan();
    plan[0].assignedRunner = 'codex';
    const res = applyTaskOps(plan, [{ op: 'update', taskId: 'b', changes: { title: 'Setup' } }, { op: 'update', taskId: 'c', changes: { assignedRunner: 'aider' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/^op 2 \(update\): .*invalid assignedRunner "aider"/);
  });

  it('rejects a runner outside the plan runner set', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'aider' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(['op 1 (update): Task "Setup" has invalid assignedRunner "aider". Expected one of: claude-code']);
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
      plan[0].assignedModel = { modelId: 'claude-code/opus', modelLabel: 'Opus', thinkingEffort: 'high' };
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
      expect(updated.taskMode).toBeUndefined();
      expect(updated.autonomy).toBeUndefined();
      expect(res.summary[0]).toContain('cleared');
      expect(res.summary[0]).toContain('assignedModel');
      expect(res.summary[0]).toContain('taskMode');
    });

    it('flips an AFK task to a manual one in a single op: user tasks are always HITL', () => {
      const plan = samplePlan();
      plan[0].sliceType = 'AFK';
      plan[0].autonomy = 'AFK';
      const res = applyTaskOps(plan, [{
        op: 'update', taskId: 'a',
        changes: { type: 'user', userSteps: [{ order: 1, instruction: 'flip the switch', completed: false }] },
      }], ['claude-code']);
      expect(res.errors).toEqual([]);
      expect(res.tasks[0]).toMatchObject({ type: 'user', sliceType: 'HITL' });
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
  it('re-arms a failed task: pending, verdict, output summary and handoff cleared', () => {
    const plan = samplePlan();
    plan[0].status = 'failed';
    plan[0].verdict = { outcome: 'fail', reason: 'broke', checks: [], decidedAt: 'now' };
    plan[0].outputSummary = { reviewReason: 'broke', logTail: 'oops', capturedAt: 'now' };
    plan[0].handoff = { summary: 'It broke.', findings: [], findingCount: 0 };
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(true);
    const rearmed = res.tasks.find((t) => t.id === 'a')!;
    expect(rearmed.status).toBe('pending');
    expect(rearmed.verdict).toBeUndefined();
    expect(rearmed.outputSummary).toBeUndefined();
    expect(rearmed.handoff).toBeUndefined();
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
    expect(blockingFailures(plan).has('b')).toBe(true); // 'b' depends on 'a'
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(blockingFailures(res.tasks).has('b')).toBe(false);
  });

  it('refuses to re-arm a running task', () => {
    const plan = samplePlan();
    plan[0].status = 'in_progress';
    const res = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/running/);
    expect(res.tasks).toBe(plan);
  });

  // A rearm used to clear less than a retry: a task force-started past its merge gate still read "forced past gate" on its next run.
  it('clears what a retry clears, keeping only the revert mark a retry would release', () => {
    const plan = samplePlan();
    Object.assign(plan[0], {
      status: 'completed',
      verdict: { outcome: 'pass', reason: 'ok', checks: [], decidedAt: 'now' },
      handoff: { summary: 'Done.', findings: [], findingCount: 0 },
      forcedPastGate: ['Earlier work'],
      carriedFrom: 'codex',
      parkedQuestion: 'Which database?',
      reverted: true,
      loopRound: 2,
    } satisfies Partial<Task>);
    const store = new PlanStore();
    store.load(plan, ['claude-code', 'codex']);
    store.retry('a');
    const retried = store.get('a')!;

    const rearmed = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a' }], ['claude-code']).tasks[0];

    for (const field of ['status', 'verdict', 'handoff', 'forcedPastGate', 'carriedFrom', 'parkedQuestion', 'loopRound'] as const) {
      expect(rearmed[field], field).toEqual(retried[field]);
    }
    expect(rearmed).toMatchObject({ status: 'pending', forcedPastGate: undefined, carriedFrom: undefined, parkedQuestion: undefined, loopRound: undefined });
    // A revert's hold is the user's to release (ADR-0054): the planner's edit keeps the mark that holds it past a restart.
    expect(retried.reverted).toBeUndefined();
    expect(rearmed.reverted).toBe(true);
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
        { id: 'plan', label: 'Plan', description: 'read-only', readOnly: true },
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

  it('refuses any task mode the planner names, valid or not, pointing at readOnly (ADR-0031)', () => {
    for (const taskMode of ['yolo', 'plan']) {
      const res = applyTaskOps(samplePlan(), [
        { op: 'update', taskId: 'a', changes: { taskMode } },
      ], ['claude-code'], CATALOG);
      expect(res.ok).toBe(false);
      expect(res.errors[0]).toContain('"taskMode" is the user\'s to choose');
      expect(res.errors[0]).toContain('"readOnly"');
    }
  });

  it('accepts a model the runner offers and within the allowlist', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' } } },
    ], ['claude-code'], { ...CATALOG, perRunnerAllowlist: { 'claude-code': ['claude-sonnet-4-5'] } });
    expect(res.ok).toBe(true);
  });

  it('refuses a model for a task whose runner is up, waiting for input or not (#106)', () => {
    const waiting = samplePlan().map((t) => (t.id === 'a' ? { ...t, status: 'awaiting_user' as const, awaitingReason: 'input' as const } : t));
    const res = applyTaskOps(waiting, [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' } } },
    ], ['claude-code'], { ...CATALOG, liveRunner: (id) => id === 'a' });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('stop the task first, or use the runner\'s own /model');
  });

  it('refuses a move to another runner for a task whose runner is up, waiting for input or not', () => {
    const waiting = samplePlan().map((t) => (t.id === 'a' ? { ...t, status: 'awaiting_user' as const, awaitingReason: 'input' as const } : t));
    const res = applyTaskOps(waiting, [
      { op: 'update', taskId: 'a', changes: { assignedRunner: 'codex' } },
    ], ['claude-code', 'codex'], { ...CATALOG, liveRunner: (id) => id === 'a' });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('"Setup" has a live runner, so its runner cannot change now: stop the task first');
  });

  it('refuses a flip to manual for a task whose runner is up, which would clear its model', () => {
    const waiting = samplePlan().map((t) => (t.id === 'a'
      ? { ...t, status: 'awaiting_user' as const, awaitingReason: 'input' as const, assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5' } }
      : t));
    const res = applyTaskOps(waiting, [
      { op: 'update', taskId: 'a', changes: { type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }] } },
    ], ['claude-code'], { ...CATALOG, liveRunner: (id) => id === 'a' });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('stop the task first, or use the runner\'s own /model');
  });

  it('accepts an allowlisted model discovery does not list, as the catalog block shows it', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'claude-fable-5', modelLabel: 'claude-fable-5' } } },
    ], ['claude-code'], { ...CATALOG, perRunnerAllowlist: { 'claude-code': ['claude-sonnet-4-5', 'claude-fable-5'] } });
    expect(res.ok).toBe(true);
  });

  it('refuses an allowlisted id another runner lists — it is provably not this runner\'s', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } } },
    ], ['claude-code'], {
      ...CATALOG,
      modelsByRunner: { ...CATALOG.modelsByRunner, codex: [{ modelId: 'gpt-5', modelLabel: 'GPT-5', variants: [] }] },
      perRunnerAllowlist: { 'claude-code': ['claude-sonnet-4-5', 'gpt-5'] },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('gpt-5');
  });

  it('lands a task the planner marks read-only on the runner\'s read-only mode', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { readOnly: true } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].taskMode).toBe('plan');
    expect(res.tasks[0]).not.toHaveProperty('readOnly');
  });

  it('refuses an added task with an invented model', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Docs', assignedModel: { modelId: 'gpt-9-imaginary', modelLabel: 'GPT-9' } } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('gpt-9-imaginary');
  });

  it('refuses an added task that names a mode', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'add', task: { title: 'Docs', taskMode: 'plan' } },
    ], ['claude-code'], CATALOG);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('"taskMode" is the user\'s to choose');
  });

  it('runs no model/mode check when no catalog is supplied (backwards compatible)', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { assignedModel: { modelId: 'anything-goes', modelLabel: 'Anything' } } },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
  });

  // Thinking effort is an alias-resolution problem, not an invention problem
  // (the assignment resolver clamps it to what the model offers) — a
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
    expect(res.errors[0]).toMatch(/defined by a later op in this batch/);
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

  it('counts a task named twice once, so merging it with itself is refused', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['#1', 'a'], merged: { title: 'x' } }], ['claude-code']);
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

  it('rewires a subtask that depended on a merged task, at any depth', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({
        id: 'c', order: 3, title: 'C', prompt: 'p', assignedRunner: 'claude-code',
        subtasks: [createTask({
          id: 'c1', order: 1, title: 'C1', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code',
          subtasks: [createTask({ id: 'c11', order: 1, title: 'C11', prompt: 'p', dependencies: ['b'], assignedRunner: 'claude-code' })],
        })],
      }),
    ];
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB' } }], ['claude-code']);
    expect(res.errors).toEqual([]);
    const merged = res.tasks.find((t) => t.title === 'AB')!;
    const c = res.tasks.find((t) => t.id === 'c')!;
    expect(c.subtasks[0].dependencies).toEqual([merged.id]);
    expect(c.subtasks[0].subtasks[0].dependencies).toEqual([merged.id]);
  });

  it('keeps the dependencies the merged spec states beside those the merged tasks had', () => {
    const plan = [
      createTask({ id: 'x', order: 1, title: 'X', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'y', order: 2, title: 'Y', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'a', order: 3, title: 'A', prompt: 'p', dependencies: ['x'], assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 4, title: 'B', prompt: 'p', assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB', dependencies: ['#2'] } }], ['claude-code']);
    expect(res.errors).toEqual([]);
    expect(res.tasks.find((t) => t.title === 'AB')!.dependencies).toEqual(['x', 'y']);
  });

  it('reads a merged spec dependency by handle, and refuses an unknown one rather than dropping it', () => {
    const plan = samplePlan();
    const byHandle = applyTaskOps(plan, [
      { op: 'add', task: { title: 'Lint', prompt: 'p' }, handle: 'lint' },
      { op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB', dependencies: ['lint'] } },
    ], ['claude-code']);
    expect(byHandle.errors).toEqual([]);
    const lint = byHandle.tasks.find((t) => t.title === 'Lint')!;
    expect(byHandle.tasks.find((t) => t.title === 'AB')!.dependencies).toEqual([lint.id]);
    expect(byHandle.tasks.findIndex((t) => t.id === lint.id)).toBeLessThan(byHandle.tasks.findIndex((t) => t.title === 'AB'));

    const unknown = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB', dependencies: ['#9'] } }], ['claude-code']);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors[0]).toMatch(/op 1 \(merge\): unknown dependencies/);
  });

  it('leaves a task that depended on both merged tasks with one dependency on the survivor', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p', dependencies: ['a', 'b'], assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB' } }], ['claude-code']);
    expect(res.errors).toEqual([]);
    const merged = res.tasks.find((t) => t.title === 'AB')!;
    expect(res.tasks.find((t) => t.id === 'c')!.dependencies).toEqual([merged.id]);
  });

  it('drops a merged spec dependency on a task it merges away, which would be a dependency on itself', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB', dependencies: ['a'] } }], ['claude-code']);
    expect(res.errors).toEqual([]);
    expect(res.tasks.find((t) => t.title === 'AB')!.dependencies).toEqual([]);
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

  it('rewires a subtask that depended on the split task to the last part', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({
        id: 'c', order: 2, title: 'C', prompt: 'p', assignedRunner: 'claude-code',
        subtasks: [createTask({ id: 'c1', order: 1, title: 'C1', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' })],
      }),
    ];
    const res = applyTaskOps(plan, [{ op: 'split', taskId: 'a', parts: [{ title: 'A1' }, { title: 'A2' }] }], ['claude-code']);
    expect(res.errors).toEqual([]);
    const last = res.tasks.find((t) => t.title === 'A2')!;
    expect(res.tasks.find((t) => t.id === 'c')!.subtasks[0].dependencies).toEqual([last.id]);
  });

  it('keeps the dependencies each part states, beside the chain and what the task had', () => {
    const plan = [
      createTask({ id: 'x', order: 1, title: 'X', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'y', order: 2, title: 'Y', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 3, title: 'B', prompt: 'p', dependencies: ['x'], assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{
      op: 'split', taskId: 'b',
      parts: [{ title: 'B1' }, { title: 'B2', dependencies: ['#2'] }],
    }], ['claude-code']);
    expect(res.errors).toEqual([]);
    const [b1, b2] = ['B1', 'B2'].map((title) => res.tasks.find((t) => t.title === title)!);
    expect(b1.dependencies).toEqual(['x']);
    expect(b2.dependencies).toEqual([b1.id, 'y']);
  });

  it('adds the first part\'s stated dependencies to the ones the split task had', () => {
    const plan = [
      createTask({ id: 'x', order: 1, title: 'X', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'y', order: 2, title: 'Y', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 3, title: 'B', prompt: 'p', dependencies: ['x'], assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{ op: 'split', taskId: 'b', parts: [{ title: 'B1', dependencies: ['y', 'x'] }, { title: 'B2' }] }], ['claude-code']);
    expect(res.errors).toEqual([]);
    expect(res.tasks.find((t) => t.title === 'B1')!.dependencies).toEqual(['x', 'y']);
  });

  it('refuses a part that names the task being split, and an unknown dependency, rather than dropping them', () => {
    const named = applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'B1' }, { title: 'B2', dependencies: ['b'] }] }], ['claude-code']);
    expect(named.ok).toBe(false);
    expect(named.errors[0]).toMatch(/split part 2.*"Build".*being split/);
    const unknown = applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'B1', dependencies: ['#9'] }, { title: 'B2' }] }], ['claude-code']);
    expect(unknown.ok).toBe(false);
    expect(unknown.errors[0]).toMatch(/split part 1.*unknown dependencies/);
  });

  it('refuses to split a completed task', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    const res = applyTaskOps(plan, [{ op: 'split', taskId: 'b', parts: [{ title: 'x' }, { title: 'y' }] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/completed/);
  });
});

describe('applyTaskOps — a busy subtree locks merge and split (ADR-0029)', () => {
  const withSub = (status: Task['status'], awaitingReason?: Task['awaitingReason']): Task[] => {
    const plan = samplePlan();
    plan[1] = { ...plan[1], subtasks: [{ ...createTask({ id: 'b1', order: 1, title: 'Sub', prompt: 'sub', status }), awaitingReason }] };
    return plan;
  };
  const merge: TaskOp = { op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB' } };
  const split: TaskOp = { op: 'split', taskId: 'b', parts: [{ title: 'x' }, { title: 'y' }] };

  it.each([['completed', /"Sub" is completed and cannot be (merged|split)/], ['in_progress', /"Sub" is running and cannot be (merged|split)/]] as const)(
    'refuses a merge and a split over a %s subtask, naming it',
    (status, pattern) => {
      for (const op of [merge, split]) {
        const res = applyTaskOps(withSub(status), [op], ['claude-code']);
        expect(res.ok, op.op).toBe(false);
        expect(res.errors[0], op.op).toMatch(pattern);
      }
    },
  );

  it('refuses over a subtask waiting at a checkpoint, and over a deeper one', () => {
    for (const op of [merge, split]) {
      expect(applyTaskOps(withSub('awaiting_user', 'checkpoint'), [op], ['claude-code']).ok, op.op).toBe(false);
      const deep = withSub('pending');
      deep[1].subtasks[0] = { ...deep[1].subtasks[0], subtasks: [createTask({ id: 'b11', order: 1, title: 'Deep', prompt: 'deep', status: 'completed' })] };
      const res = applyTaskOps(deep, [op], ['claude-code']);
      expect(res.ok, op.op).toBe(false);
      expect(res.errors[0], op.op).toContain('"Deep" is completed');
    }
  });

  it('names the pending subtasks a merge or a split drops, so the planner can add them back', () => {
    for (const op of [merge, split]) {
      const res = applyTaskOps(withSub('pending'), [op], ['claude-code']);
      expect(res.ok, op.op).toBe(true);
      expect(res.summary.join('\n'), op.op).toContain('dropped subtask "Sub"');
    }
  });

  it('says nothing about subtasks when there were none', () => {
    const res = applyTaskOps(samplePlan(), [merge], ['claude-code']);
    expect(res.summary.join('\n')).not.toContain('subtask');
  });
});

describe('a planner edit keeps its structural merge and split ops', () => {
  // Removing the dedicated Merge and Split controls leaves the planner's
  // natural-language edit path as the way to reshape a plan.
  it('applies one batch that merges two tasks and splits a third', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Setup + Build' } },
      { op: 'split', taskId: 'c', parts: [{ title: 'Test core' }, { title: 'Test UI' }] },
    ], ['claude-code']);

    expect(res.errors).toEqual([]);
    const merged = res.tasks.find((t) => t.title === 'Setup + Build')!;
    expect(merged.dependencies).toEqual([]);
    const first = res.tasks.find((t) => t.title === 'Test core')!;
    const last = res.tasks.find((t) => t.title === 'Test UI')!;
    expect(first.dependencies).toEqual([merged.id]);
    expect(last.dependencies).toEqual([first.id]);
    expect(res.tasks).toHaveLength(3);
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

describe('applyTaskOps — the ops flag (ADR-0020)', () => {
  it('flips a task that has not started, and reads anything but a literal true as a change task', () => {
    const on = applyTaskOps(samplePlan(), [{ op: 'update', taskId: '#3', changes: { ops: true } }], ['claude-code']);
    expect(on.ok).toBe(true);
    expect(on.tasks[2].ops).toBe(true);

    const garbled = applyTaskOps(on.tasks, [{ op: 'update', taskId: '#3', changes: { ops: 'yes' as unknown as boolean } }], ['claude-code']);
    expect(garbled.ok).toBe(true);
    expect(garbled.tasks[2].ops).toBeUndefined();
  });

  it('refuses it once the task has started, on a manual task, and on a subtask', () => {
    const plan = samplePlan();
    plan[0] = { ...plan[0], status: 'failed' };
    plan[1] = { ...plan[1], subtasks: [createTask({ id: 'b1', order: 1, title: 'Sub', prompt: 'sub' })] };
    plan.push(createTask({ id: 'u', order: 4, title: 'Check', type: 'user', userSteps: [{ order: 1, instruction: 'look', completed: false }] }));

    for (const [taskId, error] of [['a', 'has started'], ['b1', 'is a subtask'], ['u', 'is a manual task']]) {
      const res = applyTaskOps(plan, [{ op: 'update', taskId, changes: { ops: true } }], ['claude-code']);
      expect(res.ok).toBe(false);
      expect(res.errors.join('\n')).toContain(error);
    }
  });

  it('adds an ops task, and a merge of ops tasks stays one', () => {
    const added = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Redeploy', dependencies: ['#3'], ops: true } }], ['claude-code']);
    expect(added.tasks[3].ops).toBe(true);

    const plan = samplePlan().map((t) => (t.id === 'a' ? t : { ...t, ops: true }));
    const merged = applyTaskOps(plan, [{ op: 'merge', taskIds: ['#2', '#3'], merged: { title: 'Ship' } }], ['claude-code']);
    expect(merged.ok).toBe(true);
    expect(merged.tasks.find((t) => t.title === 'Ship')?.ops).toBe(true);
  });

  it('clears it when the task becomes manual', () => {
    const plan = samplePlan().map((t) => (t.id === 'c' ? { ...t, ops: true } : t));
    const res = applyTaskOps(plan, [{ op: 'update', taskId: '#3', changes: { type: 'user', userSteps: [{ order: 1, instruction: 'check', completed: false }] } }], ['claude-code']);

    expect(res.ok).toBe(true);
    expect(res.tasks[2].ops).toBeUndefined();
  });
});

describe('applyTaskOps — an added task\'s subtask skills', () => {
  // A subtask is a full task object, less the mode the planner never names; its skills arrive as the planner wrote them.
  const sub = (title: string, skills?: unknown[], subtasks: Task[] = []) => {
    const task: Partial<Task> = createTask({ title });
    delete task.taskMode;
    return { ...task, subtasks, ...(skills ? { skills } : {}) } as Task;
  };

  it('stores them as a task\'s are, at every depth, each independent of its parent\'s', () => {
    const res = applyTaskOps(samplePlan(), [{
      op: 'add',
      task: { title: 'Docs', skills: ['tdd'], subtasks: [sub('Child', [' Deploy ', 'Bad Name!'], [sub('Grandchild', ['LATER', 7])]), sub('Bare')] },
    }], ['claude-code']);

    expect(res.ok).toBe(true);
    const added = res.tasks[3];
    expect(added.skills).toEqual(['tdd']);
    expect(added.subtasks.map((s) => s.skills)).toEqual([['deploy'], undefined]);
    expect(added.subtasks[0].subtasks[0].skills).toEqual(['later']);
    expect('skills' in added.subtasks[1]).toBe(false);
  });
});

// A whole plan's missing mode resolves to the runner's mode under the user's
// Full/Guarded level (ADR-0001); the planner's edits must land on the same one,
// not on the generic `build`, which Claude Code runs as acceptEdits.
describe('applyTaskOps — the mode a planner edit lands a task on (ADR-0031)', () => {
  const MODES = {
    'claude-code': [
      { id: 'acceptEdits', label: 'Accept Edits', description: 'edit automatically' },
      { id: 'auto', label: 'Auto', description: 'classifier', safe: true },
      { id: 'bypassPermissions', label: 'Bypass', description: 'no prompts', autonomous: true },
      { id: 'plan', label: 'Plan', description: 'read-only', readOnly: true },
    ],
    opencode: [
      { id: 'build', label: 'Build', description: 'edits', autonomous: true, safe: true },
      { id: 'plan', label: 'Plan', description: 'read-only', readOnly: true },
    ],
    custom: [
      { id: 'write', label: 'Write', description: 'edits', autonomous: true, safe: true },
    ],
  };
  const catalog = (autonomousDefault: boolean) => ({ modelsByRunner: {}, runnerModes: MODES, autonomousDefault });
  const runners: Array<'claude-code' | 'opencode' | 'custom'> = ['claude-code', 'opencode', 'custom'];
  const added = (res: ReturnType<typeof applyTaskOps>) => res.tasks.find((t) => t.title === 'Add a cache');
  const task = (id: string, order: number, taskMode: string, assignedRunner: 'claude-code' | 'opencode' = 'claude-code') =>
    createTask({ id, order, title: `Task ${id}`, prompt: id, assignedRunner, taskMode });

  it('gives an added task the runner\'s mode for the level', () => {
    const add = [{ op: 'add' as const, task: { title: 'Add a cache', prompt: 'p', assignedRunner: 'claude-code' as const } }];
    expect(added(applyTaskOps(samplePlan(), add, runners, catalog(true)))?.taskMode).toBe('bypassPermissions');
    expect(added(applyTaskOps(samplePlan(), add, runners, catalog(false)))?.taskMode).toBe('auto');
  });

  it('gives an added read-only task the runner\'s read-only mode, and stores no readOnly field', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Add a cache', prompt: 'p', assignedRunner: 'opencode', readOnly: true } }], runners, catalog(true));
    expect(added(res)?.taskMode).toBe('plan');
    expect(added(res)).not.toHaveProperty('readOnly');
  });

  it('refuses a read-only task on a runner with no read-only mode, naming those with one', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Add a cache', prompt: 'p', assignedRunner: 'custom', readOnly: true } }], runners, catalog(true));
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('"custom" has no read-only mode');
    expect(res.errors[0]).toContain('claude-code, opencode');
  });

  it('takes a task off read-only only when told readOnly: false, onto the level\'s mode', () => {
    const plan = [task('a', 1, 'plan')];
    expect(applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { title: 'Renamed' } }], runners, catalog(false)).tasks[0].taskMode).toBe('plan');
    expect(applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { readOnly: false } }], runners, catalog(false)).tasks[0].taskMode).toBe('auto');
  });

  it('keeps a mode the user picked through planner edits that ask for no change', () => {
    const plan = [task('a', 1, 'acceptEdits')];
    expect(applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { readOnly: false } }], runners, catalog(true)).tasks[0].taskMode).toBe('acceptEdits');
    expect(applyTaskOps(plan, [{ op: 'rearm', taskId: 'a', changes: { prompt: 'again' } }], runners, catalog(true)).tasks[0].taskMode).toBe('acceptEdits');
  });

  it('moves a task to another runner onto that runner\'s mode when it does not offer the old one', () => {
    const res = applyTaskOps([task('a', 1, 'bypassPermissions')], [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'opencode' } }], runners, catalog(true));
    expect(res.ok).toBe(true);
    expect(res.tasks[0]).toMatchObject({ assignedRunner: 'opencode', taskMode: 'build' });
  });

  it('keeps a read-only task read-only when it moves, and refuses a move to a runner without a read-only mode', () => {
    const plan = [task('a', 1, 'plan', 'opencode')];
    expect(applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'claude-code' } }], runners, catalog(true)).tasks[0])
      .toMatchObject({ assignedRunner: 'claude-code', taskMode: 'plan' });
    const res = applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'custom' } }], runners, catalog(true));
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('"custom" has no read-only mode');
  });

  it('makes a merged task read-only only when every merged task was', () => {
    const merge = (plan: Task[]) => applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Both' } }], runners, catalog(false)).tasks[0].taskMode;
    expect(merge([task('a', 1, 'plan'), task('b', 2, 'plan')])).toBe('plan');
    expect(merge([task('a', 1, 'plan'), task('b', 2, 'acceptEdits')])).toBe('acceptEdits');
    expect(applyTaskOps([task('a', 1, 'plan'), task('b', 2, 'acceptEdits')], [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Both', readOnly: true } }], runners, catalog(false)).tasks[0].taskMode).toBe('plan');
  });

  it('gives split parts the split task\'s mode unless a part says otherwise', () => {
    const res = applyTaskOps([task('a', 1, 'plan')], [{ op: 'split', taskId: 'a', parts: [{ title: 'Read' }, { title: 'Write', readOnly: false }] }], runners, catalog(false));
    expect(res.tasks.map((t) => t.taskMode)).toEqual(['plan', 'auto']);
  });

  it('refuses a mode named on a merged task or a split part', () => {
    expect(applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'Setup + Build', taskMode: 'bypassPermissions' } }], runners, catalog(true)).ok).toBe(false);
    expect(applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'Build core', taskMode: 'auto' }, { title: 'Build UI' }] }], runners, catalog(true)).ok).toBe(false);
  });

  it('decides an added task\'s subtasks as a plan\'s: read-only passes down unless a subtask says otherwise', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'add', task: {
      title: 'Add a cache', prompt: 'p', assignedRunner: 'claude-code', readOnly: true,
      subtasks: [{ title: 'Read' }, { title: 'Write', readOnly: false, subtasks: [{ title: 'Deeper' }] }] as never,
    } }], runners, catalog(false));
    expect(res.ok).toBe(true);
    const [read, write] = added(res)?.subtasks ?? [];
    expect(read.taskMode).toBe('plan');
    expect(write.taskMode).toBe('auto');
    expect(write.subtasks[0].taskMode).toBe('auto');
    expect(read).not.toHaveProperty('readOnly');
  });

  it('refuses a read-only task\'s subtask on a runner with no read-only mode, in a plan as in an edit', () => {
    const child = { title: 'Child', type: 'ai', sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'custom' };
    const plan = validatePlanTasks({ tasks: [{ id: 'r', title: 'Review', sliceType: 'AFK', autonomy: 'AFK', readOnly: true, subtasks: [child] }] }, runners, MODES, true);
    const edit = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Review', readOnly: true, subtasks: [child] as never } }], runners, catalog(true));

    expect(plan.ok ? [] : plan.errors.map((e) => e.message)).toEqual([
      'subtask "Child" of "Review": Runner "custom" has no read-only mode: assign a read-only task to one of: claude-code, opencode, or drop "readOnly"',
    ]);
    expect(edit.errors).toEqual([
      'op 1 (add): subtask "Child" of "Review": Runner "custom" has no read-only mode: assign a read-only task to one of: claude-code, opencode, or drop "readOnly"',
    ]);
  });

  it('refuses a mode named on an added subtask', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Add a cache', prompt: 'p', subtasks: [{ title: 'Child', taskMode: 'bypassPermissions' }] as never } }], runners, catalog(true));
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('readOnly');
  });

  it('refuses readOnly: true on a manual task, which runs in no mode', () => {
    const manual = [createTask({ id: 'u', order: 1, title: 'Sign in', type: 'user', userSteps: [{ order: 1, instruction: 'x', completed: false }] })];
    const update = applyTaskOps(manual, [{ op: 'update', taskId: 'u', changes: { readOnly: true } }], runners, catalog(true));
    expect(update.ok).toBe(false);
    expect(update.errors[0]).toContain('manual');
    const add = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Sign in', type: 'user', readOnly: true } }], runners, catalog(true));
    expect(add.ok).toBe(false);
  });

  it('says a task is already read-only only when it is', () => {
    const res = applyTaskOps([task('a', 1, 'acceptEdits')], [{ op: 'update', taskId: 'a', changes: { readOnly: true } }], runners);
    expect(res.summary.join(' ')).not.toContain('already read-only');
    expect(applyTaskOps([task('a', 1, 'plan')], [{ op: 'update', taskId: 'a', changes: { readOnly: true } }], runners, catalog(true)).summary[0]).toContain('already read-only');
  });

  it('reports read-only in its summary, never the mode field', () => {
    const plan = [task('a', 1, 'acceptEdits')];
    const update = applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { readOnly: true } }], runners, catalog(true));
    expect(update.summary[0]).toContain('readOnly');
    expect(update.summary[0]).not.toContain('taskMode');
    const moved = applyTaskOps([task('a', 1, 'bypassPermissions')], [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'opencode' } }], runners, catalog(true));
    expect(moved.summary[0]).not.toContain('taskMode');
    const rearm = applyTaskOps(plan, [{ op: 'rearm', taskId: 'a', changes: { readOnly: true } }], runners, catalog(true));
    expect(rearm.summary[0]).not.toContain('taskMode');
  });

  it('leaves the user\'s own edit alone: any mode the runner has, at either level', () => {
    const before = samplePlan()[0];
    const outcome = resolveAssignment({ writer: 'user', task: { ...before, taskMode: 'bypassPermissions' }, before, catalog: catalog(false) });
    expect(outcome).toMatchObject({ ok: true, task: { taskMode: 'bypassPermissions' } });
  });
});

describe('research task type flips', () => {
  it.each(['user', 'script'] as const)('clears research when becoming %s through the planner', (type) => {
    const research = createTask({ id: 'r', title: 'Research', type: 'ai', prompt: 'investigate', research: true, taskMode: 'plan' });
    const result = applyTaskOps([research], [{ op: 'update', taskId: 'r', changes: type === 'user'
      ? { type, userSteps: [{ order: 1, instruction: 'check', completed: false }] }
      : { type, commands: [['git', 'status']] } }], ['claude-code']);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.tasks[0].type).toBe(type);
    expect(result.tasks[0].research).toBeFalsy();
  });
});

// A wrong-typed field was read as empty, so an edit "succeeded" by clearing what it meant to set;
// and a malformed op threw out of the text route instead of being refused for the planner to fix.
describe('a malformed task op is refused, never coerced or thrown', () => {
  it('refuses an update whose dependencies are a string, leaving the task as it was', () => {
    const plan = samplePlan();
    const result = applyTaskOps(plan, [{ op: 'update', taskId: '#3', changes: { dependencies: '#2' as unknown as string[] } }], ['claude-code']);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/dependencies" is "#[23]", which must be a list of task refs/);
    expect(result.tasks.find((t) => t.id === 'c')?.dependencies).toEqual(['b']);
  });

  it('refuses an added task whose dependencies are a string', () => {
    const result = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Ship', prompt: 'ship', dependencies: '#3' as unknown as string[] } }], ['claude-code']);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/dependencies" is "#[23]", which must be a list of task refs/);
  });

  it('reads numeric dependency refs as the orders they name', () => {
    const result = applyTaskOps(samplePlan(), [{ op: 'update', taskId: '#3', changes: { dependencies: [1] as unknown as string[] } }], ['claude-code']);
    expect(result.ok).toBe(true);
    expect(result.tasks.find((t) => t.id === 'c')?.dependencies).toEqual(['a']);
  });

  it('refuses ops whose changes, taskIds or parts are not what they hold', () => {
    const malformed = [
      { op: 'update', taskId: '#2', changes: 'title: x' },
      { op: 'reorder', taskIds: '#1,#2,#3' },
      { op: 'merge', taskIds: '#1', merged: { title: 'Both' } },
      { op: 'split', taskId: '#2', parts: 'two halves' },
    ] as unknown as TaskOp[];
    for (const op of malformed) {
      const result = applyTaskOps(samplePlan(), [op], ['claude-code']);
      expect(result.ok, JSON.stringify(op)).toBe(false);
    }
  });

  it('turns a malformed op in a text reply into a parse error the planner is asked to fix', () => {
    for (const reply of [
      '{"taskOps":[{"op":"update","taskId":"#2","changes":"title: x"}]}',
      '{"taskOps":[{"op":"reorder","taskIds":"#1,#2,#3"}]}',
      '{"taskOps":[{"op":"update","taskId":"#3","changes":{"dependencies":"#2"}}]}',
    ]) {
      expect(() => parseTaskOpsJson(reply), reply).toThrow(PlanParseError);
    }
    expect(() => parseTaskOpsJson('{"taskOps":[{"op":"update","taskId":"#3","changes":{"dependencies":"#2"}}]}')).toThrow(/dependencies/);
  });

  it('accepts numeric dependency refs in a text reply, as edit_plan does', () => {
    expect(parseTaskOpsJson('{"taskOps":[{"op":"update","taskId":3,"changes":{"dependencies":[1]}}]}'))
      .toEqual([{ op: 'update', taskId: 3, changes: { dependencies: [1] } }]);
  });
});
