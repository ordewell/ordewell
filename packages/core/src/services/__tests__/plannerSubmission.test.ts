import { describe, it, expect, vi } from 'vitest';
import type { DiscoveredModel, Task } from '../../models/Task';
import type { ConversationTurn } from '../AiService';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';
import { classifyPlannerReply } from '../PlanRepair';
import { validatePlanTasks } from '../PlanValidator';
import { makeSession } from './sessionTestKit';

const RUNNERS = ['claude-code'];

const PLAN = {
  tasks: [
    { id: 'a', order: 1, title: 'Schema', description: 'Add the table', type: 'ai', prompt: 'add the table', dependencies: [], subtasks: [],
      sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Sonnet' } },
    // Off the allowlist: both channels must coerce it the same way (ADR-0003).
    { id: 'b', order: 2, title: 'Endpoint', description: 'Serve it', type: 'ai', prompt: 'serve it', dependencies: ['a'], subtasks: [],
      sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'high' } },
  ],
};

const discovered: DiscoveredModel[] = [
  { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4', variants: [] },
  { modelId: 'claude-opus-4', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }] },
];

/** What the harness backend hands back for a reply: its text, classified the way settleReply does. */
function replyTurn(text: string): ConversationTurn {
  const reply = classifyPlannerReply(text, { runners: RUNNERS });
  if (reply.kind === 'plan') return { kind: 'plan', tasks: reply.tasks, text, researchLog: [] };
  if (reply.kind === 'task_ops') return { kind: 'task_ops', ops: reply.ops, text, researchLog: [] };
  return { kind: 'message', text, researchLog: [] };
}

function validTasks(obj: unknown): Task[] {
  const result = validatePlanTasks(obj, RUNNERS);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
  return result.tasks;
}

/**
 * A session one clarifying turn into planning, whose next planner reply is
 * `answer` — run while the turn is open, so it can hand something in first.
 */
async function sessionAnswering(answer: (session: Session) => ConversationTurn) {
  const broadcast = vi.fn<(msg: SessionMessage) => void>();
  const session: Session = makeSession({
    aiService: {
      startConversation: vi.fn().mockResolvedValue(replyTurn('What should the endpoint return?')),
      continueConversation: vi.fn(async () => answer(session)),
      hasActiveConversation: () => true,
    },
    modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({ 'claude-code': discovered }) },
    settings: () => ({ modelAllowlist: { 'claude-code': ['claude-sonnet-4'] } }),
    broadcast,
  });
  await session.startPlanning('add an endpoint', RUNNERS);
  broadcast.mockClear();
  await session.continueConversation('JSON, please');
  return { session, broadcast };
}

/** The committed outcome with the per-parse and per-turn noise (markers, ids, clocks) taken out. */
function committed(session: Session, broadcast: ReturnType<typeof vi.fn>) {
  const strip = (tasks: readonly Task[]): unknown[] => tasks.map(({ completionMarker: _, subtasks, ...rest }) => ({ ...rest, subtasks: strip(subtasks) }));
  const last = session.planState?.conversationHistory?.at(-1);
  return {
    tasks: strip(session.planTasks),
    runners: session.planState?.runners,
    lastMessage: { role: last?.role, content: last?.content, kind: last?.kind },
    broadcasts: broadcast.mock.calls.map(([msg]) => msg.type),
  };
}

describe('a plan handed in during a planner turn', () => {
  it('commits exactly as the same plan sent as the JSON envelope', async () => {
    const viaJson = await sessionAnswering(() => replyTurn(JSON.stringify(PLAN)));
    const viaSubmit = await sessionAnswering((session) => {
      expect(session.submitToTurn({ kind: 'plan', tasks: validTasks(PLAN) })).toBe(true);
      return replyTurn('Submitted the plan.');
    });

    expect(committed(viaSubmit.session, viaSubmit.broadcast)).toEqual(committed(viaJson.session, viaJson.broadcast));
    expect(viaSubmit.session.planTasks.map((t) => t.assignedModel?.modelId)).toEqual(['claude-sonnet-4', 'claude-sonnet-4']);
  });
});

describe('what a submission wins over', () => {
  it('a JSON plan in the same turn: the submitted one commits', async () => {
    const other = { tasks: [{ ...PLAN.tasks[0], id: 'json-only', title: 'From the reply' }] };
    const { session } = await sessionAnswering((s) => {
      s.submitToTurn({ kind: 'plan', tasks: validTasks(PLAN) });
      return replyTurn(JSON.stringify(other));
    });

    expect(session.planTasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('nothing once the turn has settled', async () => {
    const { session } = await sessionAnswering(() => replyTurn('Sure.'));

    expect(session.submitToTurn({ kind: 'plan', tasks: validTasks(PLAN) })).toBe(false);
    expect(session.planTasks).toEqual([]);
  });
});

describe('task ops handed in during a planner turn', () => {
  it('apply exactly as the same taskOps sent as the JSON envelope', async () => {
    const ops = { taskOps: [{ op: 'update', taskId: '#1', changes: { title: 'Schema and migration' } }] };
    const run = async (answer: (s: Session) => ConversationTurn) => {
      const { session, broadcast } = await sessionAnswering((s) => {
        if (!s.planTasks.length) {
          s.submitToTurn({ kind: 'plan', tasks: validTasks(PLAN) });
          return replyTurn('Planned.');
        }
        return answer(s);
      });
      broadcast.mockClear();
      await session.continueConversation('rename the first task');
      return { session, broadcast };
    };

    const viaJson = await run(() => replyTurn(JSON.stringify(ops)));
    const viaSubmit = await run((s) => {
      const parsed = replyTurn(JSON.stringify(ops));
      if (parsed.kind !== 'task_ops') throw new Error('fixture is not ops');
      s.submitToTurn({ kind: 'task_ops', ops: parsed.ops });
      return replyTurn('Renamed it.');
    });

    expect(committed(viaSubmit.session, viaSubmit.broadcast)).toEqual(committed(viaJson.session, viaJson.broadcast));
    expect(viaSubmit.session.planTasks[0].title).toBe('Schema and migration');
  });
});
