import { describe, it, expect, vi } from 'vitest';
import { Planner } from '../Planner';
import { createTask, type DiscoveredModel } from '../../models/Task';
import type { IAiService } from '../AiService';
import { fakeConfig } from '../../testing';
import { DEFAULT_PLANNER_MODES } from '../plannerModes';
import type { SkillLookup } from '../taskSkills';
import { parsePlanJson } from '../PlanValidator';

function discoveredModel(modelId: string, label?: string): DiscoveredModel {
  return { modelId, modelLabel: label ?? modelId, variants: [] };
}

function fakeAiService(): IAiService {
  return {
    startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hello', researchLog: [] }),
    continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hello again', researchLog: [] }),
    hasActiveConversation: vi.fn().mockReturnValue(false),
    researchAndPlan: vi.fn().mockResolvedValue({ tasks: [], researchLog: [], researchResults: '' }),
    generatePlanDirect: vi.fn().mockResolvedValue([]),
    reset: vi.fn(),
  };
}

describe('Planner', () => {
  describe('generate (one-shot)', () => {
    it('builds a draft PlanState via generatePlanDirect when research is off', async () => {
      const task = createTask({ id: 'gen1', order: 1, title: 'Generated', prompt: 'do it' });
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue([task]);

      const planner = new Planner(fakeConfig(), aiService);
      const plan = await planner.generate({
        goal: 'fix the bug',
        runners: ['claude-code'],
        modelsByRunner: { 'claude-code': [] },
      });

      expect(aiService.generatePlanDirect).toHaveBeenCalledOnce();
      expect(aiService.researchAndPlan).not.toHaveBeenCalled();
      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks[0].title).toBe('Generated');
      expect(plan.status).toBe('draft');
      expect(plan.runners).toEqual(['claude-code']);
      expect(plan.generatedAt).toBeTypeOf('string');
    });

    it('filters modelsByRunner to allowlist before passing to generatePlanDirect', async () => {
      const task = createTask({ id: 'a1', order: 1, title: 'Task', prompt: 'go', assignedRunner: 'opencode', assignedModel: { modelId: 'kimi-2.6', modelLabel: 'Kimi 2.6' } });
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue([task]);

      const planner = new Planner(fakeConfig(), aiService);
      await planner.generate({
        goal: 'test',
        runners: ['opencode'],
        modelsByRunner: { 'opencode': [discoveredModel('kimi-2.6'), discoveredModel('gpt-5')] },
        perRunnerAllowlist: { 'opencode': ['kimi-2.6'] },
      });

      const callModels: Record<string, DiscoveredModel[]> = (aiService.generatePlanDirect as import("vitest").Mock).mock.calls[0][2];
      expect(callModels['opencode']).toHaveLength(1);
      expect(callModels['opencode'][0].modelId).toBe('kimi-2.6');
    });

    it('coerces out-of-allowlist task assignments when the planner emits a stray model id', async () => {
      const strayTask = createTask({ id: 's1', order: 1, title: 'Stray', prompt: 'go', assignedRunner: 'opencode', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', thinkingEffort: 'high' } });
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue([strayTask]);

      const planner = new Planner(fakeConfig(), aiService);
      const plan = await planner.generate({
        goal: 'test',
        runners: ['opencode'],
        modelsByRunner: { 'opencode': [discoveredModel('kimi-2.6'), discoveredModel('gpt-5')] },
        perRunnerAllowlist: { 'opencode': ['kimi-2.6'] },
      });

      expect(plan.tasks).toHaveLength(1);
      expect(plan.tasks[0].assignedModel?.modelId).toBe('kimi-2.6');
      expect(plan.tasks[0].assignedModel?.thinkingEffort).toBeUndefined();
    });

    it('researches and returns tasks directly when research is on — no questions, no PRD artifacts', async () => {
      const task = createTask({ id: 'r1', order: 1, title: 'Researched', prompt: 'do it' });
      const aiService = fakeAiService();
      (aiService.researchAndPlan as import("vitest").Mock).mockResolvedValue({
        tasks: [task],
        researchLog: [{ id: 's1', tool: 'read_file', args: '{}', result: 'ok', timestamp: '' }],
        researchResults: 'some research',
      });

      const planner = new Planner(fakeConfig({ researchEnabled: true }), aiService);
      const plan = await planner.generate({
        goal: 'fix the auth bug',
        runners: ['claude-code'],
        modelsByRunner: { 'claude-code': [] },
      });

      expect(aiService.researchAndPlan).toHaveBeenCalledOnce();
      expect(aiService.generatePlanDirect).not.toHaveBeenCalled();
      expect(plan.tasks).toHaveLength(1);
      expect(plan.researchLog?.length).toBe(1);
      expect(plan.status).toBe('draft');
    });

    it('filters and coerces on the research path when research is on', async () => {
      const strayTask = createTask({ id: 'r1', order: 1, title: 'Task', prompt: 'go', assignedRunner: 'opencode', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', thinkingEffort: 'high' } });
      const aiService = fakeAiService();
      (aiService.researchAndPlan as import("vitest").Mock).mockResolvedValue({
        tasks: [strayTask],
        researchLog: [],
        researchResults: '',
      });

      const planner = new Planner(fakeConfig({ researchEnabled: true }), aiService);
      const plan = await planner.generate({
        goal: 'test',
        runners: ['opencode'],
        modelsByRunner: { 'opencode': [discoveredModel('kimi-2.6'), discoveredModel('gpt-5')] },
        perRunnerAllowlist: { 'opencode': ['kimi-2.6'] },
      });

      const callModels: Record<string, DiscoveredModel[]> = (aiService.researchAndPlan as import("vitest").Mock).mock.calls[0][2];
      expect(callModels['opencode']).toHaveLength(1);
      expect(callModels['opencode'][0].modelId).toBe('kimi-2.6');
      expect(plan.tasks[0].assignedModel?.modelId).toBe('kimi-2.6');
      expect(plan.tasks[0].assignedModel?.thinkingEffort).toBeUndefined();
    });
  });

  describe('generate and task skills', () => {
    const grilling = { name: 'grilling', description: '', metadata: { name: 'grilling', description: '' }, content: '', path: '/g/grilling/SKILL.md', source: 'global' as const, appliesTo: 'planner' as const, modelInvocable: false, userInvocable: true };
    const lookup: SkillLookup = { findSkill: (name) => (name === 'grilling' ? grilling : undefined), searchedDirs: () => [] };
    const generate = (aiService: IAiService, signal?: AbortSignal) => new Planner(fakeConfig(), aiService).generate({
      goal: 'g', runners: ['claude-code'], modelsByRunner: { 'claude-code': [discoveredModel('sonnet')] }, signal,
      modes: { ...DEFAULT_PLANNER_MODES, taskSkills: lookup },
    });

    it('refuses a plan with a planner skill on a task rather than returning it', async () => {
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue([createTask({ id: 't1', title: 'a', skills: ['grilling'] })]);

      await expect(generate(aiService)).rejects.toThrow(/Task "a": "grilling" is a planner skill/);
    });

    it('returns names not found, or no skill could have, as warnings beside the plan', async () => {
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue(parsePlanJson(JSON.stringify({ tasks: [
        { id: 't0', order: 1, title: 'w', description: 'd', prompt: 'Write .ordewell/skills/later/SKILL.md', autonomy: 'AFK', sliceType: 'AFK', assignedRunner: 'claude-code' },
        { id: 't1', order: 2, title: 'a', description: 'd', prompt: 'p', dependencies: ['t0'], autonomy: 'AFK', sliceType: 'AFK', assignedRunner: 'claude-code', skills: ['later', '-bad'] },
      ] }), ['claude-code']));

      const plan = await generate(aiService);

      expect(plan.tasks[1].skills).toEqual(['later']);
      expect(plan.skillWarnings).toEqual([
        expect.stringContaining('Task "a": "-bad" is not a valid skill name'),
        expect.stringContaining('Task "a": skill "later" not found'),
      ]);
    });

    it('lands the plan without a skill nothing provides, and warns that it was removed', async () => {
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue([
        createTask({ id: 't1', order: 1, title: 'Fix the build', prompt: 'p' }),
        createTask({ id: 't2', order: 2, title: 'Add feature', prompt: 'p', skills: ['python'], subtasks: [createTask({ id: 't2a', order: 1, title: 'Part', prompt: 'p', skills: ['rust'] })] }),
        createTask({ id: 't3', order: 3, title: 'Docs', prompt: 'p' }),
      ]);

      const plan = await generate(aiService);

      expect(plan.tasks.map((t) => t.title)).toEqual(['Fix the build', 'Add feature', 'Docs']);
      expect(plan.tasks[1].skills ?? []).toEqual([]);
      expect(plan.tasks[1].subtasks?.[0].skills ?? []).toEqual([]);
      expect(plan.skillWarnings).toEqual([
        'Task "Add feature": skill "python" is not an installed task skill, and no task it depends on creates it, so it was removed from the task\'s skills.',
        'Task "Part": skill "rust" is not an installed task skill, and no task it depends on creates it, so it was removed from the task\'s skills.',
      ]);
      expect(aiService.generatePlanDirect).toHaveBeenCalledOnce();
    });

    it('lands nothing when stopped during the skill check', async () => {
      const aiService = fakeAiService();
      const controller = new AbortController();
      (aiService.generatePlanDirect as import("vitest").Mock).mockImplementation(async () => {
        controller.abort();
        return [createTask({ id: 't1', title: 'a', skills: ['later'] })];
      });

      await expect(generate(aiService, controller.signal)).rejects.toThrow(/stopped/);
    });
  });

  describe('signal abort support', () => {
    it('passes AbortSignal through to generatePlanDirect when provided', async () => {
      const controller = new AbortController();
      const aiService = fakeAiService();
      (aiService.generatePlanDirect as import("vitest").Mock).mockResolvedValue([createTask({ id: 't1', order: 1, title: 'Test' })]);

      const planner = new Planner(fakeConfig(), aiService);
      await planner.generate({
        goal: 'test',
        runners: ['claude-code'],
        modelsByRunner: {},
        signal: controller.signal,
      });

      const calls = (aiService.generatePlanDirect as import("vitest").Mock).mock.calls[0];
      expect(calls[calls.length - 1]).toBe(controller.signal);
    });

    it('passes AbortSignal through to researchAndPlan when research enabled', async () => {
      const controller = new AbortController();
      const aiService = fakeAiService();
      (aiService.researchAndPlan as import("vitest").Mock).mockResolvedValue({ tasks: [], researchLog: [], researchResults: '' });

      const planner = new Planner(fakeConfig({ researchEnabled: true }), aiService);
      await planner.generate({
        goal: 'test',
        runners: ['claude-code'],
        modelsByRunner: {},
        signal: controller.signal,
      });

      const calls = (aiService.researchAndPlan as import("vitest").Mock).mock.calls[0];
      expect(calls).toContain(controller.signal);
    });
  });
});
