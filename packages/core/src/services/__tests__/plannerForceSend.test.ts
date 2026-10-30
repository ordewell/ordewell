import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../SessionMessage';
import type { LegacyPlanState } from '../../models/Task';
import { reduceConversation, type ConversationView } from '../../conversation/reduce';
import { fromTranscript } from '../../conversation/transcript';
import { saves } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, type Env } from './supervisorTestKit';
import { taskOf } from './sessionTestKit';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A run of one task, no supervisor, with the planner answering `text` and still at it. */
async function answering(text = 'why is task 1 slow?') {
  const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
  const answered = env.session.continueConversation(text);
  await until(() => env.planner.calls.length === 1);
  return { ...env, answered };
}

const turnEvents = (env: Env) => env.messages.filter((m): m is Extract<SessionMessage, { type: 'planner_turn_started' | 'planner_turn_ended' }> =>
  m.type === 'planner_turn_started' || m.type === 'planner_turn_ended');

describe('planner force send', () => {
  it('stops the turn in flight and answers the forced message in the turn that replaces it', async () => {
    const env = await answering();

    const forced = env.session.forceSendPrompt('use Postgres instead');
    await until(() => env.planner.calls.length === 2);

    expect(env.planner.calls[0].signal?.aborted).toBe(true);
    expect(env.planner.calls[1].message).toMatch(/use Postgres instead$/);
    env.planner.calls[1].finish(prose('Switching to Postgres.'));
    await forced;
    await env.answered;
    const [started, ended, forcedStart] = turnEvents(env);
    expect(ended).toEqual({ type: 'planner_turn_ended', turnId: started.turnId, outcome: 'stopped', forceSent: true });
    expect(forcedStart).toMatchObject({ type: 'planner_turn_started', prompt: 'use Postgres instead', forced: true });
  });

  it('records a turn it stopped before any reply as stopped, not as an empty response', async () => {
    const env = await answering();
    env.planner.state.saidBeforeStop = '';

    const forced = env.session.forceSendPrompt('use Postgres instead');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Switching to Postgres.'));
    await forced;
    await env.answered;

    const history = env.session.planState!.conversationHistory!.map((e) => e.content);
    expect(history.slice(-4)).toEqual(['why is task 1 slow?', '(Stopped before replying.)', 'use Postgres instead', 'Switching to Postgres.']);
  });

  it('keeps the run update of a wake-up turn it stops: the supervisor reads it in the turn after the forced one', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'watch' } });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('the run finished');

    const forced = env.session.forceSendPrompt('add a README task');
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).not.toContain('the run finished');
    env.planner.calls[1].finish(prose('Added.'));
    await forced;

    await until(() => env.planner.calls.length === 3);
    expect(env.planner.calls[2].message).toContain('Run update:\n- the run finished');
  });

  it('is a plain send when no turn is in flight', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });

    const sent = env.session.forceSendPrompt('add a README task');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('Added.'));
    await sent;

    const [started, ended] = turnEvents(env);
    expect(started).toEqual({ type: 'planner_turn_started', turnId: started.turnId, prompt: 'add a README task', startedAt: expect.any(String) });
    expect(ended).toEqual({ type: 'planner_turn_ended', turnId: started.turnId, outcome: 'message' });
    expect(env.session.planState!.conversationHistory!.at(-2)).toEqual({ role: 'user', content: 'add a README task', timestamp: NOW.toISOString() });
  });

  it('answers the forced message alone, ahead of a message already waiting, which keeps its place behind', async () => {
    const env = await answering();
    const waiting = env.session.continueConversation('also check lint');

    const forced = env.session.forceSendPrompt('use Postgres instead');
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/use Postgres instead$/);
    expect(env.planner.calls[1].message).not.toContain('also check lint');
    env.planner.calls[1].finish(prose('Switching to Postgres.'));
    await forced;

    await until(() => env.planner.calls.length === 3);
    expect(env.planner.calls[2].message).toMatch(/also check lint$/);
    env.planner.calls[2].finish(prose('Lint is clean.'));
    await waiting;
    expect(env.session.planState!.conversationHistory!.filter((e) => e.role === 'user').map((e) => e.content)).toEqual([
      'build it', 'why is task 1 slow?', 'use Postgres instead', 'also check lint',
    ]);
  });

  it('marks the forced message in the view a reload rebuilds, as the live view drew it', async () => {
    const env = await answering();
    const snapshots: LegacyPlanState[] = [];
    saves(env.session).mockImplementation((plan) => { snapshots.push(structuredClone(plan)); });

    const forced = env.session.forceSendPrompt('use Postgres instead');
    await until(() => env.planner.calls.length === 2);
    const pending = snapshots.at(-1)!;
    env.planner.calls[1].finish(prose('Switching to Postgres.'));
    await forced;

    const userLines = (view: ConversationView) => view.blocks.flatMap((b) => (b.type === 'message' && b.role === 'user' ? [{ text: b.text, forced: b.forced }] : []));
    const expected = [
      { text: 'build it', forced: undefined },
      { text: 'why is task 1 slow?', forced: undefined },
      { text: 'use Postgres instead', forced: true },
    ];
    const saved = snapshots.at(-1)!;
    expect(userLines(fromTranscript(saved.conversationHistory, saved.researchLog, saved.plannerUsage, saved.pendingTurns))).toEqual(expected);
    expect(userLines(fromTranscript(pending.conversationHistory, pending.researchLog, pending.plannerUsage, pending.pendingTurns)).at(-1)).toEqual({ text: 'use Postgres instead', forced: true });
    const live = env.messages.reduce(reduceConversation, fromTranscript(snapshots[0].conversationHistory, [], undefined, []));
    expect(userLines(live).at(-1)).toEqual({ text: 'use Postgres instead', forced: true });
  });

  it('leaves the run\'s running task alone: no stop, no interrupt, no message', async () => {
    const env = await answering();
    const runner = env.run.of('t1');

    const forced = env.session.forceSendPrompt('use Postgres instead');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Switching to Postgres.'));
    await forced;
    await settled();

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'in_progress', prompt: 'do t1', assignedRunner: 'claude-code' });
    expect(runner).toMatchObject({ killed: false, interrupts: 0, messages: [] });
    expect(env.run.runner.stop).not.toHaveBeenCalled();
    expect(env.session.isExecuting).toBe(true);
  });

  // ADR-0022 P2: what a tool committed in the stopped turn stays; the retry it asked for was handed to the run then.
  it('keeps the edit the stopped turn committed, and the retry it handed the run', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' }, config: { autonomousMode: true } });
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
    await until(() => taskOf(env.session, 't1')!.status === 'failed');
    const answered = env.session.continueConversation('fix the import in task 1 and retry it');
    await until(() => env.planner.calls.length === 1);
    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);
    expect(JSON.parse(retry.text).result).toBe('Task #1 "Task t1" is back in the run and starts when a slot is free.');

    const forced = env.session.forceSendPrompt('leave task 1 failed');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Leaving it.'));
    await forced;
    await answered;
    await until(() => env.run.spawnedIds().length === 2);

    expect(taskOf(env.session, 't1')!.prompt).toBe('do t1, importing from ./lib');
    expect(env.run.runner.spawn.mock.calls[1][0].prompt).toContain('do t1, importing from ./lib');
    expect(env.notices.filter((n) => n.message.startsWith('Not done:'))).toEqual([]);
  });
});
