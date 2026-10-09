import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { SessionNotice } from '../SessionMessage';
import type { SkillInfo } from '../SkillsService';
import type { ModifyDuringExecutionRequest } from '../Planner';
import { FakeTerminalSession, makeSession, testWorkspace, taskOf } from './sessionTestKit';

function skill(name: string, appliesTo: SkillInfo['appliesTo'], content = `${name} body`): SkillInfo {
  const path = `/home/u/.ordewell/skills/${name}/SKILL.md`;
  return { name, description: `${name} description`, metadata: { name, description: name }, content, path, source: 'global', appliesTo, modelInvocable: false, userInvocable: true };
}

const SKILLS = [skill('tdd', 'task'), skill('pr-style', 'task'), skill('grilling', 'planner'), skill('review', 'planner', 'REVIEW BODY')];
const skillsService = { findSkill: (name: string) => SKILLS.find((s) => s.name === name), listSkills: () => SKILLS };

function twoTaskPlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code', skills: ['tdd', 'pr-style'] }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

const opsTurn = (ops: unknown[]) => ({ kind: 'task_ops', ops, text: '', researchLog: [] });

describe('what the planner sees of a task\'s skills', () => {
  it('lists them on the task\'s plan line, omits them when there are none, and says an update replaces them', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({ skillsService, aiService: { continueConversation, hasActiveConversation: () => true } });
    session.loadPlan(twoTaskPlan(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('add pr-style to #2');

    const outgoing = continueConversation.mock.calls[0][0] as string;
    const line = (id: string) => outgoing.split('\n').find((l) => l.includes(`id=${id}`));
    expect(line('a')).toMatch(/ skills:\[tdd, pr-style\]$/);
    expect(line('b')).not.toContain('skills:');
    expect(outgoing).toContain('"skills" in "changes" REPLACES the task\'s whole skill list');
  });
});

describe('task skills checked where a planner reply lands', () => {
  it('sends an envelope plan naming a planner skill back, and lands a corrected one with a notice for a name not found', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const planned = (skills: string[]) => ({
      kind: 'plan', text: '', researchLog: [],
      tasks: [createTask({ id: 't1', order: 1, title: 'Cache', prompt: 'p', assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', skills })],
    });
    const continueConversation = vi.fn().mockResolvedValue(planned(['tdd', 'later']));
    const session = makeSession({
      skillsService,
      onNotice,
      aiService: { startConversation: vi.fn().mockResolvedValue(planned(['grilling'])), continueConversation, hasActiveConversation: () => true },
    });

    await session.startPlanning('add a cache', ['claude-code']);

    expect(continueConversation.mock.calls[0][0]).toMatch(/Task "Cache": "grilling" is a planner skill/);
    expect(session.planTasks[0].skills).toEqual(['tdd', 'later']);
    expect(onNotice).toHaveBeenCalledWith({ type: 'notice', level: 'warn', message: expect.stringContaining('Task "Cache": skill "later" not found') });
  });

  it('refuses envelope task ops attaching a planner skill through the repair loop, then lands the corrected ones with a notice', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(opsTurn([{ op: 'update', taskId: '#2', changes: { skills: ['grilling'] } }]))
      .mockResolvedValueOnce(opsTurn([{ op: 'update', taskId: '#2', changes: { skills: ['pr-style', 'later'] } }]));
    const session = makeSession({ skillsService, onNotice, aiService: { continueConversation, hasActiveConversation: () => true } });
    session.loadPlan(twoTaskPlan(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('style #2');

    expect(continueConversation.mock.calls[1][0]).toMatch(/op 1 \(update\): "grilling" is a planner skill/);
    expect(taskOf(session, 'b')!.skills).toEqual(['pr-style', 'later']);
    expect(onNotice.mock.calls.map(([n]) => [n.level, n.message])).toEqual([
      ['warn', expect.stringContaining('op 1 (update): skill "later" not found')],
    ]);
  });

  it('refuses a chip edit naming a planner skill, and warns about one not found', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const session = makeSession({ skillsService, onNotice });
    session.loadPlan(twoTaskPlan(), 'build it', testWorkspace, { persist: false });

    await expect(session.updateTask('b', { skills: ['grilling'] })).rejects.toThrow(/Task "Build": "grilling" is a planner skill/);
    expect(taskOf(session, 'b')!.skills).toBeUndefined();

    await session.updateTask('b', { skills: ['tdd', 'later'] });
    expect(taskOf(session, 'b')!.skills).toEqual(['tdd', 'later']);
    expect(onNotice).toHaveBeenCalledWith({ type: 'notice', level: 'warn', message: expect.stringContaining('Task "Build": skill "later" not found') });
  });
});

describe('a mid-run edit queued behind a running task', () => {
  function runner(): ITerminalRunner {
    return {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => new FakeTerminalSession(`s-${taskId}`, taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as ITerminalRunner;
  }

  async function queued(modify: (req: ModifyDuringExecutionRequest) => Promise<{ pendingTasks: Task[]; message: string; skillWarnings?: string[] }>, onNotice?: (notice: SessionNotice) => void) {
    const modifyDuringExecution = vi.fn(modify);
    const session = makeSession({
      skillsService,
      onNotice,
      runner: runner(),
      planner: { modifyDuringExecution },
      aiService: {
        continueConversation: vi.fn().mockResolvedValue(opsTurn([{ op: 'update', taskId: '#1', changes: { title: 'Set up v2' } }])),
        hasActiveConversation: () => true,
      },
    });
    const plan = twoTaskPlan();
    // Skills attached to the running task would be resolved at spawn, which this fake catalog does not serve.
    session.loadPlan({ ...plan, status: 'approved', tasks: plan.tasks.map((t) => ({ ...t, skills: undefined })) }, 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.continueConversation('/review /tdd rename the running step');
    expect(session.getQueuedMessages()).toHaveLength(1);
    await session.processQueuedMessages();
    return { session, modifyDuringExecution };
  }

  it('is replayed with the skills its /name tokens loaded, composed as a live send is', async () => {
    const { modifyDuringExecution } = await queued(async ({ pendingTasks }) => ({ pendingTasks, message: 'ok' }));

    const { userMessage, skills } = modifyDuringExecution.mock.calls[0][0];
    expect(userMessage).toContain('<skill name="review">\nREVIEW BODY\n</skill>');
    expect(userMessage).toContain('The user asks to use task skill "tdd"');
    expect(userMessage).toMatch(/rename the running step$/);
    expect(skills.findSkill('tdd')).toBe(SKILLS[0]);
  });

  it('tells the user about skills the rewrite names but that are not found', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    await queued(async ({ pendingTasks }) => ({ pendingTasks, message: 'ok', skillWarnings: ['Task "Build": skill "later" not found'] }), onNotice);

    expect(onNotice).toHaveBeenCalledWith({ type: 'notice', level: 'warn', message: 'Task "Build": skill "later" not found' });
  });
});
