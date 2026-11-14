import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { settleReply, type ReplyAttempt, type SettleReplyOptions } from '../settleReply';
import type { ResearchProgress, ResearchStep } from '../../models/Task';
import type { TurnRun } from '../AiService';

const PLAN_JSON = JSON.stringify({
  tasks: [{
    id: 't1', order: 1, title: 'Add widget', description: 'Adds the widget module',
    type: 'ai', dependencies: [], prompt: 'Create src/widget.ts',
    assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK', subtasks: [],
  }],
});

/** Balanced, tasks-keyed, and invalid: a botched plan the classifier asks to have re-emitted. */
const BROKEN_PLAN = '{"tasks":[{"title":"still broken"}]}';

const reply = (text: string, extra: Partial<ReplyAttempt> = {}): ReplyAttempt => ({ text, researchLog: [], ...extra });

/**
 * A model scripted one reply per call. `timeline` interleaves what was sent
 * with what the loop reported, so ordering between the two can be asserted.
 */
function model(...replies: ReplyAttempt[]) {
  const sent: string[] = [];
  const timeline: string[] = [];
  const progress: ResearchProgress[] = [];
  const opts = (extra: Partial<SettleReplyOptions> = {}): SettleReplyOptions => ({
    message: 'add persistence',
    send: async (message) => {
      sent.push(message);
      timeline.push('send');
      const next = replies.shift();
      if (!next) throw new Error('model exhausted');
      return next;
    },
    classify: { runners: ['claude-code'] },
    onProgress: (p) => { progress.push(p); timeline.push(p.type); },
    ...extra,
  });
  return { sent, timeline, progress, opts };
}

describe('settleReply', () => {
  describe('an empty reply', () => {
    it('is nudged once, and the reply to the nudge settles the turn', async () => {
      const m = model(reply(''), reply('Which store: SQLite or Postgres?'));

      const turn = await settleReply(m.opts());

      expect(turn).toEqual({ kind: 'message', text: 'Which store: SQLite or Postgres?', researchLog: [] });
      expect(m.sent).toHaveLength(2);
      expect(m.sent[1]).toContain('Your last reply was empty');
    });

    it('is reported as a failure the user can see when the nudge comes back empty too', async () => {
      const m = model(reply(''), reply('  '), reply('never asked for'));

      const turn = await settleReply(m.opts());

      expect(turn).toEqual({ kind: 'message', text: 'The planner returned an empty reply twice. Please rephrase or try again.', researchLog: [] });
      expect(m.sent).toHaveLength(2);
    });

    // A model can end on a denied call and say nothing. "Empty reply" gives
    // the user nothing to act on; the denial is the actual reason.
    it('names a denied call as the reason, to the model and then to the user', async () => {
      const denied: ResearchStep = {
        id: 'rs-1', tool: 'agent_tool', toolLabel: 'Write', args: '{"file_path":"/etc/hosts"}',
        result: 'Access denied: the planner runs read-only, so "Write" was refused.',
        success: false, outcome: 'denied', timestamp: '2026-09-27T10:00:00.000Z',
      };
      const m = model(reply('', { researchLog: [denied] }), reply('', { researchLog: [denied] }));

      const turn = await settleReply(m.opts());

      expect(m.sent[1]).toContain('"Write" was denied');
      expect(m.sent[1]).toContain('Do not retry it');
      expect(turn.text).toBe('The planner stopped without replying after "Write" was denied: Access denied: the planner runs read-only, so "Write" was refused.');
    });
  });

  describe('a botched plan', () => {
    it('is re-emitted on a corrective, and the corrected plan commits', async () => {
      const m = model(reply(BROKEN_PLAN), reply(`Here it is:\n${PLAN_JSON}`));

      const turn = await settleReply(m.opts());

      expect(turn.kind).toBe('plan');
      expect(turn.text).toBe(`Here it is:\n${PLAN_JSON}`);
      expect(m.sent[1]).toContain('Re-emit the COMPLETE corrected plan');
    });

    it('gets two corrective re-emits, then its last attempt settles as prose', async () => {
      const m = model(reply(BROKEN_PLAN), reply(BROKEN_PLAN), reply(BROKEN_PLAN), reply(PLAN_JSON));

      const turn = await settleReply(m.opts());

      expect(turn).toEqual({ kind: 'message', text: BROKEN_PLAN, researchLog: [] });
      expect(m.sent).toHaveLength(3);
    });
  });

  // Re-asking in the same context would be cut off at the same point again.
  describe('a plan cut off by the output limit', () => {
    const CUT_OFF = PLAN_JSON.slice(0, PLAN_JSON.length - 20);

    it('frees context first, then asks for a terser re-emit that says so', async () => {
      const m = model(reply(CUT_OFF), reply(PLAN_JSON));
      let compactions = 0;

      const turn = await settleReply(m.opts({ compactHistory: () => { compactions++; return 12345; } }));

      expect(turn.kind).toBe('plan');
      expect(compactions).toBe(1);
      expect(m.sent[1]).toContain('trimmed');
      expect(m.sent[1]).toContain('output length limit');
    });

    it('takes the provider at its word that a balanced reply was cut off', async () => {
      const m = model(reply(BROKEN_PLAN, { cutOff: true }), reply(PLAN_JSON));
      let compactions = 0;

      await settleReply(m.opts({ compactHistory: () => { compactions++; return 1; } }));

      expect(compactions).toBe(1);
      expect(m.sent[1]).toContain('output length limit');
    });

    it('claims no trim where the backend holds its own context', async () => {
      const m = model(reply(CUT_OFF), reply(PLAN_JSON));

      await settleReply(m.opts());

      expect(m.sent[1]).toContain('output length limit');
      expect(m.sent[1]).not.toContain('trimmed');
    });

    it('frees nothing once the repair budget is spent, since no re-emit follows', async () => {
      const m = model(reply(CUT_OFF), reply(CUT_OFF), reply(CUT_OFF));
      let compactions = 0;

      const turn = await settleReply(m.opts({ compactHistory: () => { compactions++; return 1; } }));

      expect(turn.kind).toBe('message');
      expect(compactions).toBe(2);
    });
  });

  it('settles a call that ended without a reply on the reason it gives, rather than nudging', async () => {
    const m = model(reply('', { failure: 'Claude Code exited with code 1: not logged in' }), reply('never asked for'));

    const turn = await settleReply(m.opts());

    expect(turn).toEqual({ kind: 'message', text: 'Claude Code exited with code 1: not logged in', researchLog: [], failed: true });
    expect(m.sent).toHaveLength(1);
  });

  // The planner's turn its provider failed is tried again, as a task's is (ADR-0018 E1).
  describe('a call its provider failed', () => {
    const BAD_GATEWAY = 'API Error: 502 Bad Gateway';

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('is tried again after the backoff, and the reply to the try settles the turn', async () => {
      const m = model(reply('', { failure: BAD_GATEWAY }), reply('Which store: SQLite or Postgres?'));

      const settled = settleReply(m.opts());
      await vi.advanceTimersByTimeAsync(29_000);
      expect(m.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const turn = await settled;

      expect(turn).toEqual({ kind: 'message', text: 'Which store: SQLite or Postgres?', researchLog: [] });
      expect(m.sent).toHaveLength(2);
      expect(m.sent[1]).toContain(BAD_GATEWAY);
    });

    it('redacts a key the error carries from the try', async () => {
      const key = 'sk-ant-api03-' + 'A1b2C3d4E5'.repeat(9) + '-AAAAAA';
      const m = model(reply('', { failure: `${BAD_GATEWAY} (x-api-key ${key})` }), reply('Done.'));

      const settled = settleReply(m.opts());
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;

      expect(m.sent[1]).toContain(BAD_GATEWAY);
      expect(m.sent[1]).not.toContain(key);
    });

    it('settles on the error once every try has failed', async () => {
      const m = model(...Array.from({ length: 4 }, () => reply('', { failure: BAD_GATEWAY })), reply('never asked for'));

      const settled = settleReply(m.opts());
      await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000);
      const turn = await settled;

      expect(turn).toEqual({ kind: 'message', text: BAD_GATEWAY, researchLog: [], failed: true });
      expect(m.sent).toHaveLength(4);
    });

    it('stops waiting when the turn is stopped, and settles on the error', async () => {
      const stop = new AbortController();
      const m = model(reply('', { failure: BAD_GATEWAY }), reply('never asked for'));

      const settled = settleReply(m.opts({ signal: stop.signal }));
      await vi.advanceTimersByTimeAsync(1_000);
      stop.abort();
      const turn = await settled;

      expect(turn).toMatchObject({ text: BAD_GATEWAY, failed: true });
      expect(m.sent).toHaveLength(1);
    });

    it('is not tried again on the usage limit, which has its own wait', async () => {
      const m = model(reply('', { failure: BAD_GATEWAY, usageLimit: {} }), reply('never asked for'));

      const turn = await settleReply(m.opts());

      expect(turn).toMatchObject({ text: BAD_GATEWAY, failed: true, usageLimit: {} });
      expect(m.sent).toHaveLength(1);
    });
  });

  // A harness agent asked to wait for its backgrounded subagents answers in a
  // second call; the user reads both, but only the last is the reply to judge.
  it('settles on the whole reply the user reads, and classifies only the last call\'s', async () => {
    const said = 'Two agents are exploring the dashboard.';
    const plan = model(reply(PLAN_JSON, { fullText: `${said}\n\n${PLAN_JSON}` }));
    const prose = model(reply('KPI helpers live in lib/kpis.py.', { fullText: `${said}\n\nKPI helpers live in lib/kpis.py.` }));

    const planTurn = await settleReply(plan.opts());
    const proseTurn = await settleReply(prose.opts());

    expect(planTurn.kind).toBe('plan');
    expect(planTurn.text).toBe(`${said}\n\n${PLAN_JSON}`);
    expect(proseTurn).toEqual({ kind: 'message', text: `${said}\n\nKPI helpers live in lib/kpis.py.`, researchLog: [] });
  });

  describe('a stop', () => {
    // A reply that was already in flight when the user stopped must not land
    // as a plan on whatever session is current by then.
    it('settles what the stopped call had as a message marked aborted, without classifying it', async () => {
      const m = model(reply(PLAN_JSON, { aborted: true }));

      const turn = await settleReply(m.opts());

      expect(turn).toEqual({ kind: 'message', text: PLAN_JSON, researchLog: [], aborted: true });
      expect(m.timeline).toEqual(['send', 'interrupted']);
    });

    it('spends no repair on a botched reply once the turn is stopped', async () => {
      const controller = new AbortController();
      const m = model(reply(BROKEN_PLAN), reply(PLAN_JSON));
      controller.abort();

      const turn = await settleReply(m.opts({ signal: controller.signal }));

      expect(turn.kind).toBe('message');
      expect(m.sent).toHaveLength(1);
    });
  });

  // ADR-0017 A1: settling never takes a run back. The turn carries every run
  // its surviving calls streamed, for surfaces to settle where each streamed.
  describe('the runs of a reply', () => {
    const run = (segmentId: string, text: string, narration = false): TurnRun => ({
      segmentId, text, startedAt: '2026-09-27T10:00:00.000Z', ...(narration ? { narration: true as const } : {}),
    });
    const note = (text: string) => ({ segmentId: expect.any(String), text, startedAt: expect.any(String) });

    it('are never taken back when the reply settles as prose or on a stop, and the turn carries them', async () => {
      const runs = [run('s1', 'Let me look.', true), run('s2', 'It is in src/cache.ts.')];
      const prose = model(reply('Let me look.\n\nIt is in src/cache.ts.', { runs }));
      expect(await settleReply(prose.opts({ classify: undefined }))).toEqual({ kind: 'message', text: 'Let me look.\n\nIt is in src/cache.ts.', researchLog: [], runs });
      expect(prose.timeline).toEqual(['send']);

      const stopped = model(reply('Let me look.', { aborted: true, runs: runs.slice(0, 1) }));
      expect(await settleReply(stopped.opts({ classify: undefined }))).toMatchObject({ aborted: true, runs: runs.slice(0, 1) });
      expect(stopped.timeline).toEqual(['send', 'interrupted']);
    });

    it('lose only the discarded reply to a corrective retry: the narration before its tool calls stays', async () => {
      const m = model(
        reply(BROKEN_PLAN, { runs: [run('s1', 'Checking the layout.', true), run('s2', BROKEN_PLAN)] }),
        reply('Which store?', { runs: [run('s3', 'Which store?')] }),
      );

      const turn = await settleReply(m.opts());

      expect(m.progress).toEqual([{ type: 'text_retracted', segmentId: 's2' }]);
      expect(turn.runs).toEqual([run('s1', 'Checking the layout.', true), run('s3', 'Which store?')]);
    });

    it('of an envelope are its narration alone', async () => {
      const m = model(reply(PLAN_JSON, { runs: [run('s1', 'Checking the layout.', true), run('s2', PLAN_JSON)] }));

      const turn = await settleReply(m.opts());

      expect(turn).toMatchObject({ kind: 'plan', runs: [run('s1', 'Checking the layout.', true)] });
    });

    it('end on a note written in the planner\'s place, after the narration they kept', async () => {
      const failed = model(reply('', { failure: 'The agent exited.', runs: [run('s1', 'Reading the README.', true)] }));
      expect((await settleReply(failed.opts())).runs).toEqual([run('s1', 'Reading the README.', true), note('The agent exited.')]);

      const empty = model(reply('', { runs: [run('s1', 'Reading the README.', true)] }), reply('  '));
      const report = await settleReply(empty.opts());
      expect(empty.progress).toEqual([]);
      expect(report.runs).toEqual([run('s1', 'Reading the README.', true), note(report.text)]);
    });
  });

  // What a discarded attempt streamed is taken back before the next one
  // answers in its place — a nudge included, since a reply can stream deltas
  // and still come back empty.
  it('takes back what the discarded attempt streamed before every retry', async () => {
    const m = model(reply(''), reply(BROKEN_PLAN), reply('{"taskOps":[{"update":"missing op field"}]}'), reply('Which store?'));

    await settleReply(m.opts());

    expect(m.timeline).toEqual(['send', 'text_retracted', 'send', 'text_retracted', 'send', 'text_retracted', 'send']);
  });
});

describe('settleReply for a planner that submits only through tools', () => {
  it.each([
    ['a plan', PLAN_JSON],
    ['a botched plan', BROKEN_PLAN],
    ['task edits', JSON.stringify({ taskOps: [{ op: 'remove', taskId: '#1' }] })],
    ['a read', JSON.stringify({ taskQuery: { tasks: ['#1'] } })],
  ])('settles %s in the reply as prose, sending nothing back', async (_what, text) => {
    const m = model(reply(text), reply('never asked for'));

    const turn = await settleReply(m.opts({ classify: undefined }));

    expect(turn).toEqual({ kind: 'message', text, researchLog: [] });
    expect(m.sent).toHaveLength(1);
  });

  it('nudges an empty reply toward the tool, not the plan JSON', async () => {
    const m = model(reply(''), reply('Which store?'));

    await settleReply(m.opts({ classify: undefined }));

    expect(m.sent[1]).toContain('submit the plan with submit_plan');
    expect(m.sent[1]).not.toContain('plan JSON');
  });
});
