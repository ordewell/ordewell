import { describe, it, expect } from 'vitest';
import { BaseAiService, type ResearchChat, type ResearchTurn, type ToolResult } from '../BaseAiService';
import type { ResearchLogEntry, ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';

/**
 * A one-shot plan whose dependency is spelled a little off ("task-01" for
 * "task-1") is not a failed plan: the run's spend is kept, and the research
 * log says which id was read as which task.
 */

const task = (id: string, title: string, dependencies: string[] = []) => ({
  id, order: 1, title, description: `${title} body`, type: 'ai', dependencies, prompt: `Do ${title}`,
  assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK', subtasks: [],
});
const planOf = (...tasks: unknown[]) => JSON.stringify({ tasks });

const OFF_BY_A_ZERO = planOf(task('task-1', 'Core'), task('task-2', 'Implement utils', ['task-01']));
const READ_AS = 'dependency "task-01" of "Implement utils" read as "task-1" ("Core")';

class Replies implements ResearchChat {
  constructor(private text: string) {}
  async sendMessage(): Promise<ResearchTurn> { return { text: this.text, toolCalls: [], hasToolCalls: false }; }
  async sendToolResults(_results: ToolResult[]): Promise<ResearchTurn> { throw new Error('no tools'); }
}

class TestService extends BaseAiService {
  hints: (string | undefined)[] = [];
  constructor(private replies: string[]) { super(fakeConfig({ researchMaxSteps: 3 })); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(_prompt: string, hint: string | undefined): Promise<string> {
    this.hints.push(hint);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('no more replies');
    return next;
  }
  research(text: string) {
    return this.runResearchLoop(new Replies(text), 'go', fakeFileSystem({}), () => {}, ['claude-code']);
  }
  fallback(log: ResearchLogEntry[], onProgress: (p: ResearchProgress) => void = () => {}) {
    return this.generatePlanFallback('goal', '', '', {}, ['claude-code'], onProgress, log);
  }
}

const systemLines = (log: ResearchLogEntry[]): string[] =>
  log.flatMap((entry) => ('type' in entry && entry.type === 'system' ? [entry.content] : []));

describe('a dependency id read as the task it means, in the one-shot planner', () => {
  it('keeps the plan the research loop wrote and notes the reading in its research log', async () => {
    const result = await new TestService([]).research(OFF_BY_A_ZERO);
    expect(result.tasks?.[1].dependencies).toEqual(['task-1']);
    expect(systemLines(result.researchLog)).toEqual([READ_AS]);
  });

  it('notes it, too, when the plan is asked for outright', async () => {
    const log: ResearchLogEntry[] = [];
    const { tasks } = await new TestService([OFF_BY_A_ZERO]).fallback(log);
    expect(tasks[1].dependencies).toEqual(['task-1']);
    expect(systemLines(log)).toEqual([READ_AS]);
  });

  it('asks again once for an id no task has, naming it and the ids the plan has', async () => {
    const service = new TestService([planOf(task('task-1', 'Core'), task('task-2', 'Utils', ['task-7'])), planOf(task('task-1', 'Core'), task('task-2', 'Utils', ['task-1']))]);
    const { tasks } = await service.fallback([]);
    expect(tasks[1].dependencies).toEqual(['task-1']);
    expect(service.hints[0]).toBeUndefined();
    expect(service.hints[1]).toContain('Unknown dependency "task-7"');
    expect(service.hints[1]).toContain('"task-1", "task-2"');
  });
});
