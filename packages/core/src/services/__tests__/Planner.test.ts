import { describe, it, expect, vi } from 'vitest';
import { Planner } from '../Planner';
import { createTask, type TaskSnapshot, type DiscoveredModel } from '../../models/Task';
import type { IAiService } from '../AiService';
import { fakeConfig } from '../../testing';
import { DEFAULT_PLANNER_MODES } from '../plannerModes';

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
    modifyPlan: vi.fn().mockResolvedValue({ tasks: [] }),
    sendPlanningPrompt: vi.fn().mockResolvedValue([]),
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
      const task = createTask({ id: 'a1', order: 1, title: 'Task', prompt: 'go', assignedModel: { modelId: 'kimi-2.6', modelLabel: 'Kimi 2.6' } });
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

  describe('modify', () => {
    it('delegates to aiService.modifyPlan with the existing plan', async () => {
      const aiService = fakeAiService();
      const updated = createTask({ id: 'm1', order: 1, title: 'Updated', prompt: 'y' });
      (aiService.modifyPlan as import("vitest").Mock).mockResolvedValue({ tasks: [updated] });

      const planner = new Planner(fakeConfig(), aiService);
      const existingPlan = {
        tasks: [],
        generatedAt: '',
        status: 'draft' as const,
        runners: ['claude-code' as const],
        lastUpdated: '',
      };
      const result = await planner.modify({
        existingPlan,
        userRequest: 'add a task',
        modelsByRunner: {},
      });

      expect(aiService.modifyPlan).toHaveBeenCalledWith(
        existingPlan,
        'add a task',
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        // The boolean tail collapsed into one mode set; a request that names no
        // toggles still has to arrive as a complete, defaulted one.
        DEFAULT_PLANNER_MODES,
      );
      expect(result.tasks[0].title).toBe('Updated');
    });

    it('filters modelsByRunner before modifyPlan and coerces returned tasks', async () => {
      const strayTask = createTask({ id: 'm1', order: 1, title: 'Task', prompt: 'x', assignedRunner: 'opencode', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', thinkingEffort: 'high' } });
      const aiService = fakeAiService();
      (aiService.modifyPlan as import("vitest").Mock).mockResolvedValue({ tasks: [strayTask] });

      const planner = new Planner(fakeConfig(), aiService);
      const result = await planner.modify({
        existingPlan: { tasks: [], generatedAt: '', status: 'draft', runners: ['opencode'], lastUpdated: '' },
        userRequest: 'add',
        modelsByRunner: { 'opencode': [discoveredModel('kimi-2.6'), discoveredModel('gpt-5')] },
        perRunnerAllowlist: { 'opencode': ['kimi-2.6'] },
      });

      const callModels: Record<string, DiscoveredModel[]> = (aiService.modifyPlan as import("vitest").Mock).mock.calls[0][2];
      expect(callModels['opencode']).toHaveLength(1);
      expect(callModels['opencode'][0].modelId).toBe('kimi-2.6');
      expect(result.tasks[0].assignedModel?.modelId).toBe('kimi-2.6');
      expect(result.tasks[0].assignedModel?.thinkingEffort).toBeUndefined();
    });
  });

  describe('modifyDuringExecution', () => {
    function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
      return {
        ...createTask({ id: 'snap-1', order: 1, title: 'Snap', ...overrides }),
        completedAt: Date.now(),
        retryCount: 0,
        finalized: true,
        ...overrides,
      };
    }

    it('builds a modification prompt with execution context and returns validated tasks', async () => {
      const pendingTask = createTask({ id: 't1', title: 'Add feature', status: 'pending', prompt: 'build it' });
      const updated = createTask({ id: 't1', title: 'Add feature (updated)', status: 'pending', prompt: 'build it better' });

      const aiService = fakeAiService();
      (aiService.sendPlanningPrompt as import("vitest").Mock).mockResolvedValue([updated]);

      const planner = new Planner(fakeConfig(), aiService);
      const result = await planner.modifyDuringExecution({
        executionLog: [snapshot({ id: 'completed-1', title: 'Setup', status: 'completed', finalized: true })],
        pendingTasks: [pendingTask],
        activeSessions: new Map(),
        userMessage: 'update the feature task',
        modelsByRunner: { 'claude-code': [] },
        runners: ['claude-code'],
      });

      expect(aiService.sendPlanningPrompt).toHaveBeenCalledOnce();
      const promptArg = (aiService.sendPlanningPrompt as import("vitest").Mock).mock.calls[0][0];
      expect(promptArg).toContain('EXECUTION LOG SUMMARY');
      expect(promptArg).toContain('Setup');
      expect(promptArg).toContain('MODIFICATION RULES');
      expect(promptArg).toContain('update the feature task');
      expect(result.pendingTasks).toHaveLength(1);
      expect(result.pendingTasks[0].title).toBe('Add feature (updated)');
    });

    it('automatically retries on validation failure with error feedback', async () => {
      const invalid = createTask({ id: 't1', title: 'a', dependencies: ['nonexistent'] });
      const valid = createTask({ id: 't1', title: 'a' });

      const aiService = fakeAiService();
      (aiService.sendPlanningPrompt as import("vitest").Mock)
        .mockResolvedValueOnce([invalid])
        .mockResolvedValueOnce([valid]);

      const planner = new Planner(fakeConfig(), aiService);
      const result = await planner.modifyDuringExecution({
        executionLog: [],
        pendingTasks: [],
        activeSessions: new Map(),
        userMessage: 'create a task',
        modelsByRunner: {},
        runners: ['claude-code'],
      });

      expect(aiService.sendPlanningPrompt).toHaveBeenCalledTimes(2);
      const retryPrompt = (aiService.sendPlanningPrompt as import("vitest").Mock).mock.calls[1][0];
      expect(retryPrompt).toMatch(/validation.*errors/i);
      expect(retryPrompt).toMatch(/nonexistent/);
      expect(result.pendingTasks).toHaveLength(1);
      expect(result.pendingTasks[0].id).toBe('t1');
    });

    it('throws after exhausting retry attempts', async () => {
      const invalid = createTask({ id: 't1', title: 'a', dependencies: ['nonexistent'] });

      const aiService = fakeAiService();
      (aiService.sendPlanningPrompt as import("vitest").Mock).mockResolvedValue([invalid]);

      const planner = new Planner(fakeConfig(), aiService);
      await expect(planner.modifyDuringExecution({
        executionLog: [],
        pendingTasks: [],
        activeSessions: new Map(),
        userMessage: 'create a task',
        modelsByRunner: {},
        runners: ['claude-code'],
      })).rejects.toThrow(/validation|exhausted/i);

      expect(aiService.sendPlanningPrompt).toHaveBeenCalledTimes(3);
    });

    it('filters modelsByRunner before building the prompt and coerces returned tasks', async () => {
      const strayTask = createTask({ id: 'e1', order: 1, title: 'Fix', prompt: 'x', assignedRunner: 'opencode', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5', thinkingEffort: 'high' } });
      const aiService = fakeAiService();
      (aiService.sendPlanningPrompt as import("vitest").Mock).mockResolvedValue([strayTask]);

      const planner = new Planner(fakeConfig(), aiService);
      const result = await planner.modifyDuringExecution({
        executionLog: [],
        pendingTasks: [],
        activeSessions: new Map(),
        userMessage: 'fix it',
        modelsByRunner: { 'opencode': [discoveredModel('kimi-2.6'), discoveredModel('gpt-5')] },
        runners: ['opencode'],
        perRunnerAllowlist: { 'opencode': ['kimi-2.6'] },
      });

      const promptArg = (aiService.sendPlanningPrompt as import("vitest").Mock).mock.calls[0][0];
      expect(promptArg).toContain('MODEL ASSIGNMENT');
      expect(promptArg).toContain('kimi-2.6');
      expect(promptArg).not.toContain('gpt-5');
      expect(result.pendingTasks[0].assignedModel?.modelId).toBe('kimi-2.6');
      expect(result.pendingTasks[0].assignedModel?.thinkingEffort).toBeUndefined();
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
