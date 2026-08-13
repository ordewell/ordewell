import { describe, it, expect, vi } from 'vitest';
import {
  repairLoop, classifyPlannerReply, generatePlanWithRepair,
  reEmitPlanPrompt, reEmitTaskOpsPrompt, taskOpsRejectedPrompt, modifyValidationFeedback,
  truncatedPlanReEmitPrompt, TRUNCATED_PLAN_REPAIR_INSTRUCTION, JSON_REPAIR_INSTRUCTION,
} from '../PlanRepair';
import { PlanParseError } from '../JsonExtractor';
import type { RunnerId } from '../../models/Task';

const RUNNERS: RunnerId[] = ['claude-code'];

const PLAN_JSON = JSON.stringify({
  tasks: [{
    id: 't1', order: 1, title: 'Add widget', description: 'Adds the widget module',
    type: 'ai', dependencies: [], prompt: 'Create src/widget.ts',
    assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK', subtasks: [],
  }],
});

describe('repairLoop', () => {
  it('returns the settled value without resending when the first reply interprets clean', async () => {
    const resend = vi.fn();
    const result = await repairLoop<string, number>({
      first: () => 'ok',
      resend,
      interpret: (r) => ({ done: r.length }),
      maxRepairs: 2,
      onExhausted: () => { throw new Error('unreachable'); },
    });
    expect(result).toBe(2);
    expect(resend).not.toHaveBeenCalled();
  });

  it('resends the corrective prompt on retry verdicts and settles on the fixed reply', async () => {
    const resend = vi.fn().mockResolvedValue('fixed');
    const result = await repairLoop<string, string>({
      first: () => 'broken',
      resend,
      interpret: (r) => r === 'fixed'
        ? { done: r }
        : { retry: { errors: ['bad'], corrective: 'fix it' } },
      maxRepairs: 2,
      onExhausted: () => { throw new Error('unreachable'); },
    });
    expect(result).toBe('fixed');
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resend).toHaveBeenCalledWith('fix it');
  });

  it('stops at maxRepairs and hands the last reply + errors to onExhausted', async () => {
    const resend = vi.fn().mockResolvedValue('still broken');
    const onExhausted = vi.fn().mockReturnValue('fallback');
    const result = await repairLoop<string, string>({
      first: () => 'broken',
      resend,
      interpret: () => ({ retry: { errors: ['nope'], corrective: 'again' } }),
      maxRepairs: 2,
      onExhausted,
    });
    expect(result).toBe('fallback');
    expect(resend).toHaveBeenCalledTimes(2); // N repairs = N+1 attempts
    expect(onExhausted).toHaveBeenCalledWith({ reply: 'still broken', errors: ['nope'], cause: undefined });
  });

  it('lets onExhausted throw', async () => {
    await expect(repairLoop<string, never>({
      first: () => 'broken',
      resend: async () => 'broken',
      interpret: () => ({ retry: { errors: ['e'], corrective: 'c', cause: new Error('root cause') } }),
      maxRepairs: 0,
      onExhausted: ({ cause }) => { throw cause; },
    })).rejects.toThrow('root cause');
  });

  it('propagates non-retryable throws from interpret immediately', async () => {
    const resend = vi.fn();
    await expect(repairLoop<string, never>({
      first: () => 'reply',
      resend,
      interpret: () => { throw new Error('transport died'); },
      maxRepairs: 2,
      onExhausted: () => { throw new Error('unreachable'); },
    })).rejects.toThrow('transport died');
    expect(resend).not.toHaveBeenCalled();
  });
});

describe('classifyPlannerReply', () => {
  const opts = { runners: RUNNERS };

  it('classifies a valid plan, tolerating a prose preamble', () => {
    const reply = classifyPlannerReply(`Here is the plan:\n${PLAN_JSON}`, opts);
    expect(reply.kind).toBe('plan');
    if (reply.kind === 'plan') expect(reply.tasks).toHaveLength(1);
  });

  it('classifies a valid taskOps object, checked before the plan key', () => {
    const reply = classifyPlannerReply('{"taskOps":[{"op":"remove","taskId":"#2"}]}', opts);
    expect(reply.kind).toBe('task_ops');
    if (reply.kind === 'task_ops') expect(reply.ops).toEqual([{ op: 'remove', taskId: '#2' }]);
  });

  it('flags a botched plan attempt (validation failure) as broken_plan', () => {
    const reply = classifyPlannerReply('{"tasks":[{"title":"missing everything"}]}', opts);
    expect(reply.kind).toBe('broken_plan');
    if (reply.kind === 'broken_plan') expect(reply.error).toBeInstanceOf(PlanParseError);
  });

  it('flags a truncated plan emission as broken_plan, with the truncated flag set', () => {
    const reply = classifyPlannerReply(PLAN_JSON.slice(0, PLAN_JSON.length - 20), opts);
    expect(reply.kind).toBe('broken_plan');
    if (reply.kind === 'broken_plan') expect(reply.error.truncated).toBe(true);
  });

  it('does not set the truncated flag on a balanced-but-invalid plan', () => {
    const reply = classifyPlannerReply('{"tasks":[{"title":"missing everything"}]}', opts);
    expect(reply.kind).toBe('broken_plan');
    if (reply.kind === 'broken_plan') expect(reply.error.truncated).toBe(false);
  });

  it('flags a malformed ops object as broken_task_ops', () => {
    const reply = classifyPlannerReply('{"taskOps":[{"update":"missing op field"}]}', opts);
    expect(reply.kind).toBe('broken_task_ops');
  });

  it('a malformed ops reply that also carries a plan falls through to the plan check', () => {
    const reply = classifyPlannerReply(`{"taskOps":"not an array"}\n${PLAN_JSON}`, opts);
    expect(reply.kind).toBe('plan');
  });

  it('treats prose that merely mentions the envelope keys as prose', () => {
    expect(classifyPlannerReply('The plan will list its "tasks" once you confirm.', opts).kind).toBe('prose');
    expect(classifyPlannerReply('I can edit tasks via "taskOps" whenever you like.', opts).kind).toBe('prose');
  });

  it('treats plain conversation as prose', () => {
    expect(classifyPlannerReply('Which database do you want to use?', opts).kind).toBe('prose');
  });

  it('classifies a taskQuery read as its own kind', () => {
    const reply = classifyPlannerReply('{"taskQuery":{"tasks":["#3"]}}', opts);
    expect(reply.kind).toBe('task_query');
    if (reply.kind === 'task_query') expect(reply.query.tasks).toEqual(['#3']);
  });

  it('carries the field selector and the catalog flag through', () => {
    const reply = classifyPlannerReply('{"taskQuery":{"tasks":["t1","#2"],"fields":["prompt"],"catalog":true}}', opts);
    expect(reply.kind).toBe('task_query');
    if (reply.kind !== 'task_query') return;
    expect(reply.query.tasks).toEqual(['t1', '#2']);
    expect(reply.query.fields).toEqual(['prompt']);
    expect(reply.query.catalog).toBe(true);
  });

  it('accepts a catalog-only read, which names no task at all', () => {
    const reply = classifyPlannerReply('{"taskQuery":{"catalog":true}}', opts);
    expect(reply.kind).toBe('task_query');
    if (reply.kind === 'task_query') expect(reply.query.tasks).toEqual([]);
  });

  it('flags a malformed read as broken_task_query', () => {
    expect(classifyPlannerReply('{"taskQuery":{"fields":["nonesuch"]}}', opts).kind).toBe('broken_task_query');
    expect(classifyPlannerReply('{"taskQuery":{}}', opts).kind).toBe('broken_task_query');
  });

  it('treats prose that merely mentions the read envelope as prose', () => {
    expect(classifyPlannerReply('I can read a task with "taskQuery" if you want.', opts).kind).toBe('prose');
  });
});

describe('generatePlanWithRepair truncation corrective', () => {
  it('sends the output-limit corrective, not the generic one, when the reply was cut off', async () => {
    const truncated = PLAN_JSON.slice(0, PLAN_JSON.length - 20);
    const generate = vi.fn()
      .mockResolvedValueOnce(truncated)
      .mockResolvedValueOnce(PLAN_JSON);
    const tasks = await generatePlanWithRepair(generate, RUNNERS);
    expect(tasks).toHaveLength(1);
    expect(generate).toHaveBeenLastCalledWith(TRUNCATED_PLAN_REPAIR_INSTRUCTION);
  });

  it('keeps the generic corrective for JSON that genuinely did not parse', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('{"tasks":[{"title": not-a-value}]}')
      .mockResolvedValueOnce(PLAN_JSON);
    await generatePlanWithRepair(generate, RUNNERS);
    expect(generate).toHaveBeenLastCalledWith(JSON_REPAIR_INSTRUCTION);
  });

  // The JSON parsed; a shape rule rejected it. "could not be parsed as JSON" is
  // false here, and the model answered it by re-sending the same object — the
  // failure mode that killed 4 benchmark trials.
  it('names the broken rule when complete JSON is rejected on shape, not parsing', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce('{"tasks":[{"id":"x","order":1,"title":"NoSlice","description":"d","type":"ai","dependencies":[],"subtasks":[]}]}')
      .mockResolvedValueOnce(PLAN_JSON);
    await generatePlanWithRepair(generate, RUNNERS);
    const corrective = generate.mock.calls.at(-1)?.[0] as string;
    expect(corrective).not.toBe(JSON_REPAIR_INSTRUCTION);
    expect(corrective).toContain('missing sliceType');
    expect(corrective).toContain('NoSlice');
  });
});

describe('corrective prompts', () => {
  it('name the envelope the model must re-emit', () => {
    expect(reEmitPlanPrompt('bad')).toContain('{"tasks":[...]}');
    expect(reEmitTaskOpsPrompt('bad')).toContain('{"taskOps":[...]}');
    expect(taskOpsRejectedPrompt(['e1'])).toContain('{"taskOps":[...]}');
  });

  it('truncatedPlanReEmitPrompt only claims a trim when one happened', () => {
    expect(truncatedPlanReEmitPrompt(true)).toContain('trimmed');
    expect(truncatedPlanReEmitPrompt(false)).not.toContain('trimmed');
    expect(truncatedPlanReEmitPrompt(false)).toContain('{"tasks":[...]}');
  });

  it('taskOpsRejectedPrompt lists every validation error', () => {
    const prompt = taskOpsRejectedPrompt(['cycle detected', 'unknown task']);
    expect(prompt).toContain('- cycle detected');
    expect(prompt).toContain('- unknown task');
  });

  it('modifyValidationFeedback numbers the errors and forbids code fences', () => {
    const feedback = modifyValidationFeedback(['first', 'second']);
    expect(feedback).toContain('1. first');
    expect(feedback).toContain('2. second');
    expect(feedback).toContain('Do NOT wrap in markdown code blocks');
  });
});
