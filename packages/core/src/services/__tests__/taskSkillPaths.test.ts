import { describe, it, expect, vi } from 'vitest';
import { createTask, type ConversationMessage, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import type { SkillInfo } from '../SkillsService';
import type { ModifyDuringExecutionRequest } from '../Planner';
import { FakeRunnerSession, makeSession, saves, testWorkspace, taskOf } from './sessionTestKit';
import { parsePlanJson } from '../PlanValidator';

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

const skillCheckNote = (history: ConversationMessage[] | undefined) =>
  history?.find((m) => m.kind === 'system' && m.content.startsWith('Skill check:'));

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
    const broadcast = vi.fn<(message: SessionMessage) => void>();
    const planned = (skills: string[]) => ({
      kind: 'plan', text: '', researchLog: [],
      tasks: [createTask({ id: 't1', order: 1, title: 'Cache', prompt: 'p', assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', skills })],
    });
    const continueConversation = vi.fn().mockResolvedValue(planned(['tdd', 'later']));
    const session = makeSession({
      skillsService,
      onNotice,
      broadcast,
      aiService: { startConversation: vi.fn().mockResolvedValue(planned(['grilling'])), continueConversation, hasActiveConversation: () => true },
    });

    await session.startPlanning('add a cache', ['claude-code']);

    expect(continueConversation.mock.calls[0][0]).toMatch(/Task "Cache": "grilling" is a planner skill/);
    expect(session.planTasks[0].skills).toEqual(['tdd', 'later']);
    expect(onNotice).toHaveBeenCalledWith({ type: 'notice', level: 'warn', message: expect.stringContaining('Task "Cache": skill "later" not found') });
    const note = skillCheckNote(session.planState?.conversationHistory);
    expect(note?.content).toMatch(/^Skill check:\n- Task "Cache": skill "later" not found/);
    const generated = broadcast.mock.calls.map(([m]) => m).filter((m) => m.type === 'plan_generated');
    expect(generated.at(-1)?.plan.conversationHistory?.at(-1)).toEqual(note);
  });

  // What the planner submitted, as parsing saw it: the check reports what parsing had to drop.
  const parsedPlan = (subtaskSkills: unknown[]) => parsePlanJson(JSON.stringify({
    tasks: [
      { id: 'a', order: 1, title: 'Make it', description: 'd', prompt: 'p', assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK' },
      {
        id: 'b', order: 2, title: 'Use it', description: 'd', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK',
        subtasks: [{ id: 'b1', order: 1, title: 'Wire it', description: 'd', type: 'ai', skills: subtaskSkills }],
      },
    ],
  }), ['claude-code']);

  it('lands a one-shot plan with a warning for a nested name not found or not valid, each name attached once', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const generatePlanDirect = vi.fn(async () => parsedPlan(['Bad Name!', 'TDD', 'tdd', 'later']));
    const session = makeSession({ skillsService, onNotice, aiService: { generatePlanDirect } });

    await session.generatePlan('make and use a skill', ['claude-code']);

    expect(taskOf(session, 'b1')!.skills).toEqual(['tdd', 'later']);
    const note = skillCheckNote(session.planState?.conversationHistory);
    expect(note?.content).toContain('- Task "Wire it": "Bad Name!" is not a valid skill name');
    expect(note?.content).toContain('- Task "Wire it": skill "later" not found');
    expect(saves(session).mock.calls.at(-1)![0].conversationHistory).toContainEqual(note);
    expect(onNotice.mock.calls.map(([n]) => [n.level, n.message])).toEqual([
      ['warn', expect.stringContaining('"Bad Name!" is not a valid skill name')],
      ['warn', expect.stringContaining('skill "later" not found')],
    ]);
  });

  it('refuses a one-shot plan attaching a planner skill to a subtask, and loads, saves and broadcasts none of it', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const broadcast = vi.fn<(message: SessionMessage) => void>();
    const generatePlanDirect = vi.fn(async () => parsedPlan(['tdd', 'grilling']));
    const session = makeSession({ skillsService, onNotice, broadcast, aiService: { generatePlanDirect } });

    await expect(session.generatePlan('make and use a skill', ['claude-code'])).rejects.toThrow(/Task "Wire it": "grilling" is a planner skill/);

    expect(session.planTasks).toEqual([]);
    expect(saves(session)).not.toHaveBeenCalled();
    expect(broadcast.mock.calls.filter(([m]) => m.type === 'plan_generated')).toEqual([]);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('warns about a name an API planner\'s envelope plan could not attach, as it was written', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const tasks = parsedPlan(['Bad Name!', 'pr-style']);
    const session = makeSession({
      skillsService,
      onNotice,
      aiService: { startConversation: vi.fn().mockResolvedValue({ kind: 'plan', tasks, text: '', researchLog: [] }), hasActiveConversation: () => true },
    });

    await session.startPlanning('add a cache', ['claude-code']);

    expect(taskOf(session, 'b1')!.skills).toEqual(['pr-style']);
    expect(skillCheckNote(session.planState?.conversationHistory)?.content).toBe(
      'Skill check:\n- Task "Wire it": "Bad Name!" is not a valid skill name (lowercase letters, digits, "-" and "_", starting with a letter or digit), so it was not attached.',
    );
    expect(onNotice).toHaveBeenCalledWith({ type: 'notice', level: 'warn', message: expect.stringContaining('"Bad Name!" is not a valid skill name') });
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
    expect(skillCheckNote(session.planState?.conversationHistory)?.content).toContain('- op 1 (update): skill "later" not found');
  });

  it('refuses a mixed envelope batch whose added task carries a planner skill on a subtask, changing nothing, then lands the corrected nested names', async () => {
    const onNotice = vi.fn<(notice: SessionNotice) => void>();
    const sub = (title: string, skills: unknown[], subtasks: unknown[] = []): unknown => ({ ...createTask({ title }), subtasks, skills });
    const batch = (child: unknown) => [
      { op: 'update', taskId: '#1', changes: { title: 'Renamed' } },
      { op: 'add', task: { title: 'Docs', skills: ['tdd'], subtasks: [child] } },
    ];
    let between: string[] = [];
    const continueConversation = vi.fn()
      .mockResolvedValueOnce(opsTurn(batch(sub('Wire', ['grilling']))))
      .mockImplementationOnce(async () => {
        between = session.planTasks.map((t) => t.title);
        return opsTurn(batch(sub('Wire', ['pr-style', 'Bad Name!', 'later'], [sub('Deep', ['tdd'])])));
      });
    const session = makeSession({ skillsService, onNotice, aiService: { continueConversation, hasActiveConversation: () => true } });
    session.loadPlan(twoTaskPlan(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('document it');

    expect(continueConversation.mock.calls[1][0]).toMatch(/op 2 \(add\): subtask "Wire": "grilling" is a planner skill/);
    expect(between).toEqual(['Setup', 'Build']);
    const docs = session.planTasks.find((t) => t.title === 'Docs')!;
    expect(session.planTasks[0].title).toBe('Renamed');
    expect(docs.skills).toEqual(['tdd']);
    expect(docs.subtasks[0].skills).toEqual(['pr-style', 'later']);
    expect(docs.subtasks[0].subtasks[0].skills).toEqual(['tdd']);
    expect(onNotice.mock.calls.map(([n]) => n.message)).toEqual([
      expect.stringMatching(/^op 2 \(add\): subtask "Wire": "Bad Name!" is not a valid skill name/),
      expect.stringMatching(/^op 2 \(add\): subtask "Wire": skill "later" not found/),
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
  function runner(): IRunner {
    return {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => new FakeRunnerSession(`s-${taskId}`, taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;
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
    const { session } = await queued(async ({ pendingTasks }) => ({ pendingTasks, message: 'ok', skillWarnings: ['Task "Build": skill "later" not found'] }), onNotice);

    expect(onNotice).toHaveBeenCalledWith({ type: 'notice', level: 'warn', message: 'Task "Build": skill "later" not found' });
    expect(skillCheckNote(session.planState?.conversationHistory)?.content).toBe('Skill check:\n- Task "Build": skill "later" not found');
  });
});
