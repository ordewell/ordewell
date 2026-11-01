import { describe, it, expect, vi } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { IAiService } from '../AiService';
import { makeSession, scriptedPlanner, type PlannerTurn } from './sessionTestKit';

/**
 * Who a Session lets write a delegated task, on the routes a planner has
 * (ADR-0055 D21, ADR-0056 M2): a delegated task exists only where the build
 * offers delegation and the mandate grants it, and a flat session's planner is
 * handed nothing new.
 */

const signal = new AbortController().signal;
const SPEC = {
  id: 'd', order: 1, title: 'A subtree', description: 'd', type: 'delegated', goal: 'Reach it', sliceType: 'AFK', dependencies: [],
  budget: { tokens: 1_000_000 }, protectedPaths: ['tests/'],
};
const CHECK = { id: 'c', order: 2, title: 'Check it', description: 'c', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['d'] };

function sessionWith(turns: PlannerTurn[], { tokens = 0, offered = false }: { tokens?: number; offered?: boolean } = {}) {
  const planner = scriptedPlanner(turns);
  const session = makeSession({
    aiService: { reset: vi.fn(), ...planner.service } as unknown as Partial<IAiService>,
    delegationOffered: offered,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: tokens } }),
    modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({}) },
  });
  return { session, planner };
}

describe('a planner\'s conversation', () => {
  it('hands a flat session\'s planner nothing of delegation', async () => {
    const { session, planner } = sessionWith([async () => undefined]);
    await session.startPlanning('A goal');
    const [request] = planner.requests;
    expect(request.delegation).toBeUndefined();
    expect(request.subplanner).toBeUndefined();
    expect(Object.keys(request.plannerTools ?? {}).sort()).toEqual(['handler', 'sessionId']);
    session.destroy();
  });

  it('hands nothing either where a setting asks for it and the build does not offer it (D21)', async () => {
    const { session, planner } = sessionWith([async () => undefined], { tokens: 5_000_000 });
    await session.startPlanning('A goal');
    expect(planner.requests[0].delegation).toBeUndefined();
    expect(planner.requests[0].plannerTools?.delegates).toBeUndefined();
    session.destroy();
  });

  it('teaches it, with the tree\'s budget, where the build offers it and the mandate grants it', async () => {
    const { session, planner } = sessionWith([async () => undefined], { tokens: 5_000_000, offered: true });
    await session.startPlanning('A goal');
    expect(planner.requests[0].plannerTools?.delegates).toBe(true);
    expect(planner.requests[0].delegation).toMatchObject({ tokens: 5_000_000, delegatedTasks: 8 });
    session.destroy();
  });
});

describe('submit_plan and edit_plan', () => {
  const replies: { text: string; isError?: boolean }[] = [];
  const SUBMIT: PlannerTurn = async (tools) => { replies.push(await tools.submitPlan!({ tasks: [SPEC, CHECK] as never }, { signal })); };
  const ADD_FIRST: PlannerTurn = async (tools) => {
    await tools.submitPlan!({ tasks: [{ ...CHECK, dependencies: [], readOnly: false }] as never }, { signal });
    replies.push(await tools.editPlan!({ ops: [{ op: 'add', task: { ...SPEC, id: undefined, order: undefined } }] as never }, { signal }));
  };

  it('write a delegated task where it is granted', async () => {
    replies.length = 0;
    const { session } = sessionWith([SUBMIT], { tokens: 5_000_000, offered: true });
    await session.startPlanning('A goal');
    expect(replies[0].isError).toBeFalsy();
    expect(session.planTasks[0]).toMatchObject({ type: 'delegated', goal: 'Reach it', budget: { tokens: 1_000_000 } });
    session.destroy();
  });

  it('refuse one where delegation is off, naming the grant, as an edit does', async () => {
    replies.length = 0;
    const { session } = sessionWith([SUBMIT], { tokens: 0, offered: true });
    await session.startPlanning('A goal');
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('it needs the delegate grant') });
    session.destroy();

    replies.length = 0;
    const edited = sessionWith([ADD_FIRST], { tokens: 0, offered: true });
    await edited.session.startPlanning('A goal');
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('it needs the delegate grant') });
    edited.session.destroy();
  });

  it('refuse one in a build that does not offer it, whatever a setting says', async () => {
    replies.length = 0;
    const { session } = sessionWith([SUBMIT], { tokens: 5_000_000, offered: false });
    await session.startPlanning('A goal');
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('delegation is not available in this session') });
    session.destroy();
  });

  it('refuse a read-only script where it could not run', async () => {
    replies.length = 0;
    const script = { id: 's', order: 2, title: 'Test it', description: 's', type: 'script', commands: [['npm', 'test']], readOnly: true, sliceType: 'AFK', dependencies: ['d'] };
    const { session } = sessionWith([async (tools) => { replies.push(await tools.submitPlan!({ tasks: [SPEC, script] as never }, { signal })); }], { tokens: 5_000_000, offered: true });
    await session.startPlanning('A goal');
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('no sandbox to seal one in') });
    session.destroy();
  });
});
