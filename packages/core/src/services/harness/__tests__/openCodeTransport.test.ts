import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'events';
import type { ApprovalDecision } from '../../../interfaces/IApproval';
import type { AgentEvent, TaskStartOptions } from '../AgentAdapter';
import { mcpClientConfig } from '../../mcp';
import { sseResponse } from '../../__tests__/harnessTestKit';
import {
  ChildSessions, OpenCodePermissions, PendingSteers, ReplyText, autoApproves, delay, interruptAcknowledged, newUserMessageId, openCodePlannerAsk, openEventStream, permissionReply, settleTurn,
  splitModelId, turnLatch, usageRecord, type PermissionRequest,
} from '../openCodeTransport';

/**
 * The protocol work OpenCode 1.x and 2.x share, driven directly. The adapter
 * suites (openCodeTaskMode, openCodeV2) prove each version wires it in.
 */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('splitModelId', () => {
  it('splits on the first slash, keeping any later ones in the model id', () => {
    expect(splitModelId('anthropic/claude-sonnet-4')).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });
    expect(splitModelId('openrouter/anthropic/claude-sonnet-4')).toEqual({ providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' });
  });

  it.each(['sonnet', '/sonnet', 'anthropic/'])('takes %s for no model id', (id) => {
    expect(splitModelId(id)).toBeNull();
  });
});

describe('delay', () => {
  // Every status poll waits on the turn's signal once a second; a listener
  // left behind per wait grew without bound over a long turn.
  it('leaves no listener on the signal once it has waited', async () => {
    const abort = new AbortController();
    for (let i = 0; i < 3; i++) await delay(1, abort.signal);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('ends early when the signal aborts', async () => {
    const abort = new AbortController();
    const waited = delay(60_000, abort.signal);
    abort.abort();
    await expect(waited).resolves.toBeUndefined();
  });
});

describe('permissionReply', () => {
  it.each([
    [{ decision: 'allow' }, { reply: 'once' }],
    [{ decision: 'allowForTask' }, { reply: 'always' }],
    [{ decision: 'deny' }, { reply: 'reject' }],
    [{ decision: 'deny', note: '  ' }, { reply: 'reject' }],
    [{ decision: 'deny', note: ' use the fixture ' }, { reply: 'reject', message: 'use the fixture' }],
  ] as [ApprovalDecision, unknown][])('answers %o as %o', (decision, body) => {
    expect(permissionReply(decision, 'reply')).toEqual(body);
  });

  it('names the answer by the version\'s own key', () => {
    expect(permissionReply({ decision: 'allowForTask' }, 'decision')).toEqual({ decision: 'always' });
  });
});

describe('usageRecord', () => {
  it('counts cache writes as uncached prompt and reasoning as output', () => {
    expect(usageRecord({ input: 3, output: 10, reasoning: 5, cache: { read: 100, write: 20 } }, { model: 'p/m', cost: 0.5, subagentId: 'call_1' })).toEqual({
      source: 'opencode', inputTokens: 123, cachedInputTokens: 100, outputTokens: 15, model: 'p/m', reportedCost: { amount: 0.5, currency: 'USD' }, subagentId: 'call_1',
    });
  });

  it('reports nothing for no counts or all zeros, and no cost for a reported 0', () => {
    expect(usageRecord(undefined, {})).toBeNull();
    expect(usageRecord({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, { cost: 0.1 })).toBeNull();
    expect(usageRecord({ input: 1, output: 1 }, { cost: 0 })).toEqual({ source: 'opencode', inputTokens: 1, outputTokens: 1 });
  });
});

describe('PendingSteers', () => {
  it('names a user message in the shape OpenCode stores', () => {
    expect(newUserMessageId()).toMatch(/^msg_[0-9a-f]{24}$/);
    expect(newUserMessageId()).not.toBe(newUserMessageId());
  });

  it('delivers a hand when an assistant message is parented to its stored id, once', () => {
    const steers = new PendingSteers();
    steers.hand('msg_a', 'm-1');

    expect(steers.deliveredBy('msg_other')).toEqual([]);
    expect(steers.deliveredBy('msg_a')).toEqual(['m-1']);
    expect(steers.deliveredBy('msg_a')).toEqual([]);
  });

  it('delivers an earlier hand when the answer is parented to a later one', () => {
    const steers = new PendingSteers();
    steers.hand('msg_a', 'm-1');
    steers.hand('msg_b', 'm-2');

    expect(steers.deliveredBy('msg_b')).toEqual(['m-1', 'm-2']);
  });

  it('forgets a hand whose request failed, but not one already delivered', () => {
    const steers = new PendingSteers();
    steers.hand('msg_a', 'm-1');
    expect(steers.forget('m-1')).toBe(true);
    expect(steers.forget('m-1')).toBe(false);

    steers.hand('msg_b', 'm-2');
    steers.deliveredBy('msg_b');
    expect(steers.forget('m-2')).toBe(false);
  });

  it('drains what is still owed, oldest first, and empties itself', () => {
    const steers = new PendingSteers();
    steers.hand('msg_a', 'm-1');
    steers.hand('msg_b', 'm-2');
    steers.deliveredBy('msg_a');

    expect(steers.drain()).toEqual([{ messageId: 'msg_b', id: 'm-2' }]);
    expect(steers.drain()).toEqual([]);
  });
});

describe('autoApproves', () => {
  const task = (approvals?: string): TaskStartOptions => ({ kind: 'task', cwd: '/w', mode: 'm', flags: { permissionMode: 'm', modeSettings: approvals ? { approvals } : {} } });

  it('holds only for a mode whose manifest sets approvals: auto', () => {
    expect(autoApproves(task('auto'))).toBe(true);
    expect(autoApproves(task('ask'))).toBe(false);
    expect(autoApproves(task())).toBe(false);
  });
});

describe('OpenCodePermissions', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' });
  const request = (id: string, name = 'bash'): PermissionRequest => ({ type: 'permission_request', id, name, detail: '{}' });

  function desk(ordewell: typeof mcp | null = null, failReplies = false) {
    const replies: [string, string, ApprovalDecision][] = [];
    const events: AgentEvent[] = [];
    const permissions = new OpenCodePermissions(async (id, sessionId, decision) => {
      replies.push([id, sessionId, decision]);
      if (failReplies) throw new Error('gone');
    }, () => ordewell);
    return { permissions, replies, events, onEvent: (e: AgentEvent) => events.push(e) };
  }

  it('holds a planner\'s request open for its envelope, once however often it is raised', () => {
    const { permissions, replies, events, onEvent } = desk();
    const seen = new Set<string>();
    permissions.ask(request('per_1'), 'ses', false, seen, onEvent);
    permissions.ask(request('per_1'), 'ses', false, seen, onEvent);

    expect(events).toEqual([request('per_1')]);
    expect(replies).toEqual([]);
    expect(permissions.answer('per_1', { decision: 'deny', note: 'no' })).toBe(true);
    expect(replies).toEqual([['per_1', 'ses', { decision: 'deny', note: 'no' }]]);
  });

  it('allows the planner its Ordewell tool at once', () => {
    const { permissions, replies, onEvent } = desk(mcp);
    permissions.ask(request('per_1', 'ordewell_submit_plan'), 'ses', false, new Set(), onEvent);

    expect(replies).toEqual([['per_1', 'ses', { decision: 'allow' }]]);
  });

  it('answers a task\'s request at once under auto approvals, and shows it decided', () => {
    const { permissions, replies, events, onEvent } = desk();
    permissions.ask(request('per_1'), 'ses', true, new Set(), onEvent);

    expect(events).toEqual([{ ...request('per_1'), decided: { decision: 'allow' } }]);
    expect(replies).toEqual([['per_1', 'ses', { decision: 'allow' }]]);
  });

  it('answers a task\'s Ordewell tool at once under any mode', () => {
    const { permissions, replies, events, onEvent } = desk(mcp);
    permissions.ask(request('per_1', 'ordewell_task_complete'), 'ses', false, new Set(), onEvent);

    expect(events).toEqual([{ ...request('per_1', 'ordewell_task_complete'), decided: { decision: 'allow' } }]);
    expect(replies).toHaveLength(1);
  });

  it('leaves any other task request open until a person answers it, once, on the session that asked', () => {
    const { permissions, replies, events, onEvent } = desk();
    permissions.ask(request('per_1'), 'ses_child', false, new Set(), onEvent);

    expect(events).toEqual([request('per_1')]);
    expect(replies).toEqual([]);
    expect(permissions.answer('per_1', { decision: 'deny', note: 'no' })).toBe(true);
    expect(permissions.answer('per_1', { decision: 'allow' })).toBe(false);
    expect(replies).toEqual([['per_1', 'ses_child', { decision: 'deny', note: 'no' }]]);
  });

  it('withdraws a request OpenCode settled itself, and only an open one', () => {
    const { permissions, events, onEvent } = desk();
    permissions.ask(request('per_1'), 'ses', false, new Set(), onEvent);
    permissions.withdraw('per_1', onEvent);
    permissions.withdraw('per_1', onEvent);
    permissions.withdraw(undefined, onEvent);

    expect(events.slice(1)).toEqual([{ type: 'permission_cancelled', id: 'per_1' }]);
    expect(permissions.answer('per_1', { decision: 'allow' })).toBe(false);
  });

  it('cancels every request still open', () => {
    const { permissions, events, onEvent } = desk();
    permissions.ask(request('per_1'), 'ses', false, new Set(), onEvent);
    permissions.ask(request('per_2'), 'ses', false, new Set(), onEvent);
    permissions.cancelAll(onEvent);
    permissions.cancelAll(onEvent);

    expect(events.slice(2)).toEqual([{ type: 'permission_cancelled', id: 'per_1' }, { type: 'permission_cancelled', id: 'per_2' }]);
  });

  it('takes a reply the server fails as answered', async () => {
    const { permissions, onEvent } = desk(null, true);
    permissions.ask(request('per_1'), 'ses', false, new Set(), onEvent);
    expect(permissions.answer('per_1', { decision: 'allow' })).toBe(true);
    await tick();
  });
});

describe('ReplyText', () => {
  function collect() {
    const events: AgentEvent[] = [];
    return { events, onEvent: (e: AgentEvent) => events.push(e) };
  }

  it('opens a paragraph for each run after the first, and emits a run once', () => {
    const text = new ReplyText();
    const { events, onEvent } = collect();
    text.complete('a', 'First.', onEvent);
    text.complete('a', 'First.', onEvent);
    text.complete('b', 'Second.', onEvent);

    expect(events).toEqual([{ type: 'assistant_text', text: 'First.' }, { type: 'assistant_text', text: '\n\nSecond.' }]);
  });

  it('drops a run of nothing but whitespace', () => {
    const text = new ReplyText();
    const { events, onEvent } = collect();
    text.complete('a', '\n\n', onEvent);
    text.complete('b', 'Reply.', onEvent);

    expect(events).toEqual([{ type: 'assistant_text', text: 'Reply.' }]);
  });

  it('streams deltas that add up to the completed run, holding back leading whitespace', () => {
    const text = new ReplyText();
    const { events, onEvent } = collect();
    text.complete('a', 'First.', onEvent);
    text.delta('b', '\n', onEvent);
    text.delta('b', 'Sec', onEvent);
    text.delta('b', 'ond.', onEvent);
    text.complete('b', '\nSecond.', onEvent);
    text.delta('b', 'late', onEvent);

    expect(events.slice(1)).toEqual([
      { type: 'assistant_text_delta', text: '\n\n\nSec' },
      { type: 'assistant_text_delta', text: 'ond.' },
      { type: 'assistant_text', text: '\n\n\nSecond.' },
    ]);
  });
});

describe('ChildSessions', () => {
  it('follows only children it was told of, and holds their frames until the owning call is named', () => {
    const children = new ChildSessions<string>();
    expect(children.follows('ses_c')).toBe(false);
    children.created('ses_c');
    expect(children.follows('ses_c')).toBe(true);

    expect(children.claim('ses_c', 'f1')).toBeNull();
    expect(children.claim('ses_c', 'f2')).toBeNull();
    expect(children.owns('call_1')).toBe(false);
    expect(children.adopt('ses_c', 'call_1')).toEqual(['f1', 'f2']);
    expect(children.adopt('ses_c', 'call_1')).toBeNull();
    expect(children.claim('ses_c', 'f3')).toBe('call_1');
    expect(children.owns('call_1')).toBe(true);
  });

  it('adopts a child whose creation it never saw, and keeps a second creation from untying it', () => {
    const children = new ChildSessions<string>();
    expect(children.adopt('ses_c', 'call_1')).toEqual([]);
    children.created('ses_c');
    expect(children.claim('ses_c', 'f')).toBe('call_1');
  });
});

describe('settleTurn', () => {
  function settlement(overrides: Partial<Parameters<typeof settleTurn>[1]> = {}) {
    const order: string[] = [];
    const events: AgentEvent[] = [];
    const permissions = new OpenCodePermissions(async () => {}, () => null);
    permissions.ask({ type: 'permission_request', id: 'per_1', name: 'bash', detail: '{}' }, 'ses', false, new Set(), () => {});
    const how = {
      processEnded: new Promise<void>(() => {}),
      exitMessage: () => 'The server exited.',
      readBack: async () => { order.push('readBack'); },
      permissions,
      outcome: (): AgentEvent => { order.push('outcome'); return { type: 'turn_end' }; },
      ...overrides,
    };
    return { how, order, events, onEvent: (e: AgentEvent) => events.push(e) };
  }

  it('reads back, cancels what is still open, then reports the outcome', async () => {
    const turn = turnLatch();
    const { how, order, events, onEvent } = settlement();
    const settled = settleTurn(turn, how, onEvent);
    turn.finish();

    expect(await settled).toBe(true);
    expect(order).toEqual(['readBack', 'outcome']);
    expect(events).toEqual([{ type: 'permission_cancelled', id: 'per_1' }, { type: 'turn_end' }]);
  });

  it('fails the turn when the server exits first', async () => {
    let exit: () => void = () => {};
    const { how, order, events, onEvent } = settlement({ processEnded: new Promise<void>((resolve) => { exit = resolve; }) });
    const settled = settleTurn(turnLatch(), how, onEvent);
    exit();

    expect(await settled).toBe(true);
    expect(order).toEqual([]);
    expect(events).toEqual([{ type: 'error', message: 'The server exited.' }]);
  });

  it('says so and reports nothing when the caller aborts, before or during the wait', async () => {
    const early = new AbortController();
    early.abort();
    const first = settlement({ signal: early.signal });
    expect(await settleTurn(turnLatch(), first.how, first.onEvent)).toBe(false);
    expect(first.events).toEqual([]);

    const late = new AbortController();
    const second = settlement({ signal: late.signal });
    const settled = settleTurn(turnLatch(), second.how, second.onEvent);
    late.abort();
    expect(await settled).toBe(false);
    expect(second.events).toEqual([]);
  });
});

describe('interruptAcknowledged', () => {
  it('holds once the turn ends, and not when the server exits or time runs out first', async () => {
    const ended = turnLatch();
    const acknowledged = interruptAcknowledged(ended, new Promise(() => {}), 5000);
    ended.finish();
    expect(await acknowledged).toBe(true);

    expect(await interruptAcknowledged(turnLatch(), Promise.resolve(), 5000)).toBe(false);
    expect(await interruptAcknowledged(turnLatch(), new Promise(() => {}), 10)).toBe(false);
  });
});

describe('openEventStream', () => {
  it('parses data frames across reads, skips lines that are none, and counts every read as activity', async () => {
    const frames: unknown[] = [];
    let activity = 0;
    let feed: ReturnType<typeof sseResponse>['stream'] | null = null;
    const close = await openEventStream<unknown>(async (signal) => {
      const { response, stream } = sseResponse({ signal });
      feed = stream;
      return response;
    }, (frame) => frames.push(frame), () => { activity++; });

    feed!.pushRaw(': keepalive\n\nevent: message\n');
    feed!.pushRaw('data: {"a":');
    feed!.pushRaw('1}\n\ndata: {broken\n\ndata:{"b":2}\n');
    feed!.pushRaw('data: {"unterminated":true}');
    await feed!.drained;
    await tick();
    await close();

    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(activity).toBe(4);
  });

  it('keeps reading when a frame\'s handler throws', async () => {
    const frames: unknown[] = [];
    const close = await openEventStream<{ n: number }>(
      async (signal) => sseResponse({ signal }, ['data: {"n":1}\n\n', 'data: {"n":2}\n\n']).response,
      (frame) => { frames.push(frame); if (frame.n === 1) throw new Error('bad frame'); },
    );
    for (let i = 0; i < 10 && frames.length < 2; i++) await tick();
    await close();

    expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('gives the turn its post when the server has no stream, or refuses it', async () => {
    const closeBodiless = await openEventStream(async () => ({ ok: true, body: null }) as unknown as Response, () => {});
    await closeBodiless();
    const closeRefused = await openEventStream(async () => { throw new Error('ECONNREFUSED'); }, () => {});
    await closeRefused();
  });

  it('stops waiting for a stream that never connects, and still closes it', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      let opened = false;
      const open = openEventStream(async (signal) => {
        opened = true;
        signal.addEventListener('abort', () => { aborted = true; });
        return new Promise<Response | null>(() => {});
      }, () => {});
      let settled = false;
      void open.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(4999);
      expect(opened).toBe(true);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      void (await open)();
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the stream on close', async () => {
    let aborted = false;
    const close = await openEventStream(async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return sseResponse({ signal }).response;
    }, () => {});
    await close();
    expect(aborted).toBe(true);
  });
});

describe('openCodePlannerAsk', () => {
  const servers = ['todoist', 'todoist_beta'];

  it('reads a fetch and an outside read from the request', () => {
    expect(openCodePlannerAsk('webfetch', { metadata: { url: 'https://example.com' } }, servers)).toEqual({ kind: 'fetch', url: 'https://example.com' });
    expect(openCodePlannerAsk('external_directory', { metadata: { filepath: '/etc/hostname', parentDir: '/etc' } }, servers))
      .toEqual({ kind: 'path', path: '/etc/hostname', directory: false });
    expect(openCodePlannerAsk('external_directory', { patterns: ['/opt/data/*'] }, servers)).toEqual({ kind: 'path', path: '/opt/data', directory: true });
  });

  it('falls back to the request\'s pattern, and takes a request that names nothing for one it cannot approve', () => {
    expect(openCodePlannerAsk('webfetch', { patterns: ['https://example.com/a'] }, servers)).toEqual({ kind: 'fetch', url: 'https://example.com/a' });
    expect(openCodePlannerAsk('external_directory', { metadata: { parentDir: '/srv' } }, servers)).toEqual({ kind: 'path', path: '/srv', directory: true });
    expect(openCodePlannerAsk('webfetch', {}, servers)).toEqual({ kind: 'other' });
    expect(openCodePlannerAsk('external_directory', {}, servers)).toEqual({ kind: 'other' });
  });

  it('names an MCP tool by the longest server it starts with', () => {
    expect(openCodePlannerAsk('todoist_beta_find-tasks', {}, servers)).toEqual({ kind: 'mcp', scope: 'todoist_beta_find-tasks', tool: 'find-tasks', server: 'todoist_beta' });
    expect(openCodePlannerAsk('todoist_add-tasks', {}, servers)).toEqual({ kind: 'mcp', scope: 'todoist_add-tasks', tool: 'add-tasks', server: 'todoist' });
  });

  it('never takes a built-in, or a tool of a server it was not told about, for an MCP tool', () => {
    for (const name of ['bash', 'edit', 'write', 'task', 'question', 'notebook_edit']) {
      expect(openCodePlannerAsk(name, {}, servers), name).toEqual({ kind: 'other' });
    }
  });
});
