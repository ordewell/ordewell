import { describe, expect, it } from 'vitest';
import { createEmptyPlan, createTask, type PlanState, type SkillLoad, type Task, type TaskSkillSnapshot } from '../../models/Task';
import { surfacePlan, surfacePlanState } from '../SessionMessage';

const BODY = 'Ask hard questions.';
const load: SkillLoad = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md', content: BODY };
const snapshot: TaskSkillSnapshot = { name: 'tdd', source: 'workspace', path: '.ordewell/skills/tdd/SKILL.md', content: BODY };

// createTask does not copy execution state, so the snapshot is set after it.
const attempted = (overrides: Partial<Task> = {}): Task => ({ ...createTask(overrides), attemptSkills: [snapshot] });

describe('surfacePlan', () => {
  const plan = () => ({
    ...createEmptyPlan(),
    tasks: [attempted({ id: 't1', subtasks: [attempted({ id: 't1.1' })] })],
    conversationHistory: [{ role: 'user' as const, content: 'x', timestamp: '2026-01-01T00:00:00Z', kind: 'skill_load' as const, skill: load }],
    queuedMessages: [{ id: 'q1', text: 'go', timestamp: '2026-01-01T00:00:01Z', skills: [load] }],
    prdMarkdown: '# PRD',
  });

  it('keeps the raw plan\'s fields and drops every body from the loads, queue and attempt snapshots', () => {
    const raw = plan();
    const out = surfacePlan(raw);

    expect(JSON.stringify(out)).not.toContain(BODY);
    expect(out.conversationHistory?.[0].skill).toEqual({ invokedBy: 'user', name: 'grilling', source: 'global', path: load.path });
    expect(out.queuedMessages?.[0].skills).toEqual([{ invokedBy: 'user', name: 'grilling', source: 'global', path: load.path }]);
    expect(out.tasks[0].attemptSkills).toEqual([{ name: 'tdd', source: 'workspace', path: snapshot.path }]);
    expect(out.tasks[0].subtasks[0].attemptSkills).toEqual([{ name: 'tdd', source: 'workspace', path: snapshot.path }]);
    expect(out).toMatchObject({ prdMarkdown: '# PRD', generatedAt: raw.generatedAt, status: raw.status });
    expect(raw.conversationHistory[0].skill.content).toBe(BODY);
    expect(raw.tasks[0].attemptSkills?.[0].content).toBe(BODY);
  });
});

describe('surfacePlanState', () => {
  it('strips the snapshots of pending and logged tasks in either phase', () => {
    const task = attempted({ id: 't1' });
    const executing: PlanState = {
      phase: 'executing', history: [], message: '', goal: 'g', runners: [], status: 'running',
      pendingTasks: [task],
      executionLog: [{ ...task, completedAt: 1, retryCount: 0, finalized: true }],
    };
    const planning: PlanState = { phase: 'planning', history: [], message: '', pendingTasks: [task] };

    for (const state of [executing, planning]) {
      const out = surfacePlanState(state);
      expect(JSON.stringify(out)).not.toContain(BODY);
      expect(out.pendingTasks[0].attemptSkills).toEqual([{ name: 'tdd', source: 'workspace', path: snapshot.path }]);
    }
  });
});
