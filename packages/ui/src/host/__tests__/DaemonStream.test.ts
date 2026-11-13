import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMPTY_RUN, reduceRun,
  type DaemonFrame, type RunSnapshotFrame, type RunView, type SerializedTask, type SessionFrame, type SessionMessage,
} from '@ordewell/core';
import { DaemonSessionStream, type DaemonSessionState } from '../DaemonStream';
import { SessionView, type SessionCue } from '../SessionView';
import type { SavedConversation } from '../ConversationViewHost';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, patchedBlocks, type HostToWebview, type PatchedView } from '../../protocol';

/** A webview stand-in: what was posted, and the conversation it would draw from it. */
function webview() {
  const posts: HostToWebview[] = [];
  let view: PatchedView = EMPTY_PATCHED_VIEW;
  return {
    post: (msg: HostToWebview) => {
      posts.push(msg);
      if (msg.type === 'conversationPatch') view = applyConversationPatch(view, msg);
    },
    posts,
    blocks: () => patchedBlocks(view),
    run: (): RunView | undefined => posts.flatMap((m) => (m.type === 'runView' ? [m.view] : [])).at(-1),
    /** A snapshot that says again what the run already was posts it again; nothing else may differ. */
    drawn: () => posts.filter((m) => m.type !== 'runView'),
  };
}

/** Lets a load's promise land; the conversation's flush timer stays faked. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function planned(id: string, order: number): SerializedTask {
  return {
    id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
  };
}

const EMPTY_SAVED: SavedConversation = { conversationHistory: [], researchLog: [] };
const TURN = 't-1';

/** A session as its broadcaster told it, start to stop: a planner turn, a plan, a run that asks and is blocked. */
const RECORDED: SessionMessage[] = [
  { type: 'planner_turn_started', turnId: TURN, prompt: 'add a parser' },
  { type: 'planner_text_delta', turnId: TURN, segmentId: 's1', text: 'Reading ' },
  { type: 'planner_text_delta', turnId: TURN, segmentId: 's1', text: 'the code.' },
  { type: 'planner_message', content: 'Reading the code.', timestamp: '2026-01-01T00:00:00.000Z', turnId: TURN },
  { type: 'planner_turn_ended', turnId: TURN, outcome: 'plan' },
  { type: 'plan_generated', plan: { tasks: [planned('t1', 1), planned('t2', 2)], runners: ['claude-code'], generatedAt: 'x' }, goal: 'g', runners: ['claude-code'] },
  { type: 'task_started', taskId: 't1', order: 1, title: 'Task t1', runner: 'claude-code' },
  { type: 'task_output', taskId: 't1', text: 'building' },
  { type: 'status_update', tasks: [{ id: 't1', status: 'in_progress', verdict: null }, { id: 't2', status: 'pending', verdict: null }] },
  { type: 'task_log', taskId: 't1', attempt: 1, events: [{ type: 'runner_loaded', commands: [], mcpServers: [] }] },
  { type: 'approval_request', id: 'a1', kind: 'shell_command', subject: 'npm test', scope: 'once' },
  { type: 'approval_settled', id: 'a1', granted: true },
  { type: 'status_update', tasks: [{ id: 't1', status: 'completed', verdict: null }, { id: 't2', status: 'pending', verdict: null }] },
  { type: 'isolation_blocked', reason: 'dirty', message: 'The tree has uncommitted changes.' },
  { type: 'execution_stopped' },
];

const stamped = (msg: SessionMessage, seq: number, stream = 'd1'): SessionFrame => ({ ...msg, stream, seq });
const snapshotAt = (view: RunView, seq: number, stream = 'd1'): RunSnapshotFrame => ({ type: 'run_snapshot', sessionId: 'root', view, stream, seq });

function inProcess(messages: readonly SessionMessage[]) {
  const screen = webview();
  const view = new SessionView(screen.post);
  const cues: SessionCue[] = [];
  view.reload(EMPTY_SAVED);
  for (const msg of messages) {
    const cue = view.receive(msg);
    if (cue) cues.push(cue);
  }
  vi.runAllTimers();
  return { screen, cues };
}

function daemon(load: () => Promise<DaemonSessionState> = () => Promise.resolve({ conversation: EMPTY_SAVED })) {
  const screen = webview();
  const cues: SessionCue[] = [];
  const hooks = { load: vi.fn(load), cue: (cue: SessionCue) => cues.push(cue), notice: vi.fn(), failed: vi.fn() };
  const stream = new DaemonSessionStream(new SessionView(screen.post), screen.post, hooks);
  return { screen, cues, hooks, stream, feed: (...frames: DaemonFrame[]) => frames.forEach((f) => stream.receive(f)) };
}

describe('DaemonSessionStream', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('draws a recorded session exactly as the in-process host does, copies and a repeated snapshot included', async () => {
    const want = inProcess(RECORDED);

    const got = daemon();
    got.feed({ type: 'connected', sessionId: 'root' }, snapshotAt(EMPTY_RUN, 0));
    await settle();
    let run = EMPTY_RUN;
    RECORDED.forEach((msg, i) => {
      const seq = i + 1;
      run = reduceRun(run, msg);
      got.feed(stamped(msg, seq));
      // A second socket on the same session lags one frame behind.
      if (seq > 1) got.feed(stamped(RECORDED[i - 1]!, seq - 1));
      // A snapshot that says again what the frames already did.
      if (seq === 9) got.feed(snapshotAt(run, seq));
    });
    vi.runAllTimers();

    expect(got.hooks.load).toHaveBeenCalledTimes(1);
    expect(got.screen.drawn()).toEqual(want.screen.drawn());
    expect(got.screen.blocks()).toEqual(want.screen.blocks());
    expect(got.screen.run()).toEqual(want.screen.run());
    expect(got.cues).toEqual(want.cues);
  });

  it('asks the host for what only it can do, in the session\'s order', () => {
    const { cues, screen } = inProcess(RECORDED);
    expect(cues).toEqual([
      { type: 'plan' },
      { type: 'plan', dock: 'run' },
      { type: 'commands', taskId: 't1' },
      { type: 'reveal' },
      { type: 'plan', dock: 'run' },
      {
        type: 'confirm',
        request: {
          kind: 'isolation_blocked',
          message: 'The tree has uncommitted changes.',
          choices: [{ id: 'stash', label: 'Stash and continue' }, { id: 'shared_root', label: 'Run without isolation' }, { id: 'cancel', label: 'Cancel' }],
        },
      },
      { type: 'settled', dock: 'draft' },
    ]);
    expect(screen.posts).toContainEqual({ type: 'taskOutput', taskId: 't1', text: 'building' });
    // The runner by the name the app gives it everywhere else, not its id.
    expect(JSON.stringify(screen.blocks())).toContain('Started \\"Task t1\\" · Claude Code');
    expect(screen.posts).toContainEqual({ type: 'taskCommands', taskId: 't1', commands: [] });
  });

  it('draws nothing before the load it follows, then every frame held behind it', async () => {
    let resolve!: (state: DaemonSessionState) => void;
    const got = daemon(() => new Promise((r) => { resolve = r; }));
    got.feed(stamped(RECORDED[5]!, 1), stamped(RECORDED[6]!, 2));
    expect(got.cues).toEqual([]);
    expect(got.screen.run()).toBeUndefined();

    resolve({ conversation: EMPTY_SAVED });
    await settle();

    expect(got.cues).toEqual([{ type: 'plan' }]);
    expect(got.screen.run()?.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('reads the session again after a gap, and goes on from what that read returned', async () => {
    const got = daemon();
    got.feed(snapshotAt(EMPTY_RUN, 0));
    await settle();
    got.feed(stamped(RECORDED[5]!, 1));
    expect(got.hooks.load).toHaveBeenCalledTimes(1);

    // 2 never came.
    got.feed(stamped(RECORDED[8]!, 3));
    expect(got.hooks.load).toHaveBeenCalledTimes(2);
    got.feed(stamped(RECORDED[9]!, 4));
    expect(got.cues).toEqual([{ type: 'plan' }]);

    await settle();
    expect(got.cues).toEqual([{ type: 'plan' }, { type: 'plan', dock: 'run' }, { type: 'commands', taskId: 't1' }]);
    expect(got.screen.run()?.tasks.find((t) => t.id === 't1')?.status).toBe('in_progress');
  });

  it('reads again when a second gap opens while a read is out, since that read may predate it', async () => {
    const got = daemon();
    got.feed(stamped(RECORDED[5]!, 1));
    got.feed(stamped(RECORDED[8]!, 5));
    expect(got.hooks.load).toHaveBeenCalledTimes(1);

    await settle();
    await settle();

    expect(got.hooks.load).toHaveBeenCalledTimes(2);
    expect(got.cues).toEqual([{ type: 'plan' }, { type: 'plan', dock: 'run' }]);
  });

  it('reads again when the daemon restarted, whose numbers start over', async () => {
    const got = daemon();
    got.feed(stamped(RECORDED[5]!, 1), stamped(RECORDED[8]!, 2));
    await settle();
    expect(got.hooks.load).toHaveBeenCalledTimes(1);

    got.feed(stamped(RECORDED[12]!, 1, 'd2'));
    expect(got.hooks.load).toHaveBeenCalledTimes(2);
    await settle();

    // Seq 1 again, but on a new stream: not a copy.
    expect(got.screen.run()?.tasks.find((t) => t.id === 't1')?.status).toBe('completed');
  });

  it('keeps what a failed read held, and reads again at the next frame', async () => {
    let fail = true;
    const got = daemon(() => (fail ? Promise.reject(new Error('daemon away')) : Promise.resolve({ conversation: EMPTY_SAVED })));
    got.feed(stamped(RECORDED[5]!, 1));
    await settle();
    expect(got.hooks.failed).toHaveBeenCalledWith(new Error('daemon away'));
    expect(got.cues).toEqual([]);

    fail = false;
    got.feed(stamped(RECORDED[8]!, 2));
    await settle();

    expect(got.hooks.load).toHaveBeenCalledTimes(2);
    expect(got.cues).toEqual([{ type: 'plan' }, { type: 'plan', dock: 'run' }]);
  });

  it('drops a status a later snapshot already accounts for, and keeps conversation that came with it', async () => {
    const got = daemon();
    const run = reduceRun(reduceRun(EMPTY_RUN, RECORDED[5]!), RECORDED[12]!);
    got.feed(stamped(RECORDED[5]!, 1), snapshotAt(run, 3));
    await settle();

    // Lagging on an older socket: the status is over, the delta is not.
    got.feed(stamped(RECORDED[8]!, 2));
    got.feed(stamped({ type: 'planner_turn_started', turnId: 'late' }, 4));

    expect(got.screen.run()?.tasks.find((t) => t.id === 't1')?.status).toBe('completed');
    expect(got.screen.posts).toContainEqual(expect.objectContaining({ type: 'plannerTurn', active: true }));
  });

  it('redraws from what a load read: the transcript, the run, a turn already running', async () => {
    const run = reduceRun(EMPTY_RUN, RECORDED[5]!);
    const got = daemon(() => Promise.resolve({
      conversation: { conversationHistory: [{ role: 'user', content: 'add a parser', timestamp: '2026-01-01T00:00:00.000Z' }], researchLog: [] },
      run,
      plannerTurnId: TURN,
    }));
    got.feed(snapshotAt(EMPTY_RUN, 0));
    await settle();
    got.feed(stamped(RECORDED[2]!, 1));
    vi.runAllTimers();

    expect(got.screen.blocks().some((b) => JSON.stringify(b).includes('add a parser'))).toBe(true);
    expect(got.screen.blocks().some((b) => JSON.stringify(b).includes('the code.'))).toBe(true);
    // The snapshot held behind the load was older than the read's run, and the frames after it say nothing of tasks.
    expect(got.screen.run()).toEqual(EMPTY_RUN);
  });

  // A turn that ended while the read was out is in the transcript the read returned, and on the socket behind it.
  it('draws once what the read already holds, by the position it read at', async () => {
    const conversation: SavedConversation = {
      conversationHistory: [
        { role: 'user', content: 'add a parser', timestamp: '2025-12-31T23:59:00.000Z' },
        { role: 'assistant', content: 'Reading the code.', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
      researchLog: [],
    };
    let resolve!: (state: DaemonSessionState) => void;
    const got = daemon(() => new Promise((r) => { resolve = r; }));
    got.feed(...RECORDED.slice(0, 5).map((msg, i) => stamped(msg, i + 1)));

    resolve({ conversation, position: { stream: 'd1', seq: 5 } });
    await settle();
    vi.runAllTimers();

    const want = webview();
    new SessionView(want.post).reload(conversation);
    vi.runAllTimers();
    expect(got.screen.blocks()).toEqual(want.blocks());
    expect(JSON.stringify(got.screen.blocks()).split('Reading the code.')).toHaveLength(2);

    // What came after the read is news.
    got.feed(stamped(RECORDED[5]!, 6));
    expect(got.cues).toEqual([{ type: 'plan' }]);
  });

  it('passes the tree and account limits on unheld, each limit revision once', () => {
    const got = daemon();
    const limits = [{ runner: 'claude-code', windows: [] }] as unknown as Extract<DaemonFrame, { type: 'account_limits' }>['limits'];
    const frame = (revision: number, stream = 'd1'): DaemonFrame => ({ type: 'account_limits', limits, sessionId: 'root', stream, revision });
    got.feed(frame(1), frame(1), frame(0), frame(2), frame(1, 'd2'));
    got.feed({ type: 'child_tree', sessionId: 'root', children: [] });

    expect(got.screen.posts.filter((m) => m.type === 'accountLimits')).toHaveLength(3);
    expect(got.screen.posts).toContainEqual({ type: 'children', children: [], rootId: 'root' });
    expect(got.hooks.load).not.toHaveBeenCalled();
  });

  it('gives a daemon notice to the host, not the chat', async () => {
    const got = daemon();
    got.feed(snapshotAt(EMPTY_RUN, 0));
    await settle();
    const notice = { type: 'notice' as const, level: 'warn' as const, message: 'Slow disk.', stream: 'd1', seq: 1 };
    got.feed(notice);
    expect(got.hooks.notice).toHaveBeenCalledWith(notice);
  });

  it('draws nothing once closed, even from a read already out', async () => {
    const got = daemon();
    got.feed(stamped(RECORDED[5]!, 1));
    got.stream.close();
    await settle();
    got.feed(stamped(RECORDED[8]!, 2));
    expect(got.cues).toEqual([]);
    expect(got.hooks.load).toHaveBeenCalledTimes(1);
  });
});
