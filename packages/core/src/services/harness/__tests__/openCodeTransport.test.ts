import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'events';
import type { ApprovalDecision } from '../../../interfaces/IApproval';
import type { AgentEvent, TaskStartOptions } from '../AgentAdapter';
import { mcpClientConfig } from '../../mcp';
import { sseResponse } from '../../__tests__/harnessTestKit';
import {
  ChildSessions, PendingSteers, autoApproves, delay, interruptAcknowledged, newUserMessageId, openCodePermissions, openCodePlannerAsk, openEventStream, permissionReply, plannerSystem, raiseOnce, settleTurn,
  splitModelId, turnLatch, usageRecord, withDeadline,
} from '../openCodeTransport';
import { OPENCODE_ORDEWELL, OPENCODE_PLANNER_PERMISSION } from '../openCodeOrdewell';
import type { LedgerStance, RaisedRequest } from '../permissionLedger';

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

describe('withDeadline', () => {
  it('follows a signal that is already aborted, so no request goes out under a turn that ended', () => {
    const controller = new AbortController();
    const reason = new Error('turn over');
    controller.abort(reason);

    const { signal, clear } = withDeadline(controller.signal, 60_000);
    clear();

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(reason);
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
      source: 'opencode', inputTokens: 123, cachedInputTokens: 100, outputTokens: 15, model: 'p/m', reportedCost: { amount: 0.5, currency: 'USD', kind: 'estimate' }, subagentId: 'call_1',
    });
  });

  it('reports nothing for no counts or all zeros, and no cost for a reported 0', () => {
    expect(usageRecord(undefined, {})).toBeNull();
    expect(usageRecord({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, { cost: 0.1 })).toBeNull();
    expect(usageRecord({ input: 1, output: 1 }, { cost: 0 })).toEqual({ source: 'opencode', inputTokens: 1, outputTokens: 1, contextTokens: 2 });
  });

  it('counts a side the runner left unreported as nothing, and takes an unreported prompt for an empty one', () => {
    expect(usageRecord({ input: 2, reasoning: 3 }, {})).toEqual({ source: 'opencode', inputTokens: 2, outputTokens: 3, contextTokens: 5 });
    expect(usageRecord({ output: 4 }, {})).toEqual({ source: 'opencode', outputTokens: 4, contextTokens: 4 });
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

  it('forgets the hand it was asked about and leaves an earlier one owed', () => {
    const steers = new PendingSteers();
    steers.hand('msg_a', 'm-1');
    steers.hand('msg_b', 'm-2');

    expect(steers.forget('m-2')).toBe(true);
    expect(steers.drain()).toEqual([{ messageId: 'msg_a', id: 'm-1' }]);
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

describe('openCodePermissions', () => {
  const request = (id: string, name = 'bash'): RaisedRequest => ({ id, name, detail: '{}', ordewell: false });
  const TASK: LedgerStance = { role: 'task', autoApprove: false };

  function desk(failReplies = false) {
    const replies: [string, string, ApprovalDecision][] = [];
    const events: AgentEvent[] = [];
    const permissions = openCodePermissions(async (id, sessionId, decision) => {
      replies.push([id, sessionId, decision]);
      if (failReplies) throw new Error('gone');
    }, () => TASK);
    return { permissions, replies, events, onEvent: (e: AgentEvent) => events.push(e) };
  }

  it('raises a request once however often a turn sees it, and answers it on the session that asked', async () => {
    const { permissions, replies, events, onEvent } = desk();
    const seen = new Set<string>();
    raiseOnce(permissions, request('per_1'), 'ses_child', seen, onEvent);
    raiseOnce(permissions, request('per_1'), 'ses_child', seen, onEvent);

    expect(events).toEqual([{ type: 'permission_request', id: 'per_1', name: 'bash', detail: '{}', suggestions: [] }]);
    expect(await permissions.answerAsync('per_1', { decision: 'deny', note: 'no' })).toBe(true);
    expect(replies).toEqual([['per_1', 'ses_child', { decision: 'deny', note: 'no' }]]);
  });

  it('keeps a reply the server fails open', async () => {
    const { permissions, onEvent } = desk(true);
    raiseOnce(permissions, request('per_1'), 'ses', new Set(), onEvent);
    await expect(permissions.answerAsync('per_1', { decision: 'allow' })).rejects.toThrow('gone');
    await expect(permissions.answerAsync('per_1', { decision: 'allow' })).rejects.toThrow('gone');
  });

  // OpenCode names a tool `<server>_<tool>`, so a server named `ordewell_x` puts its tools under Ordewell's prefix.
  it.each(['ordewell_x_task_complete', 'ordewell_evil', 'ordewell_'])('does not take %s for an Ordewell tool: only its own tool names are', (name) => {
    expect(OPENCODE_ORDEWELL.isOrdewellAsk(name)).toBe(false);
  });

  it.each(['ordewell_submit_plan', 'ordewell_task_complete'])('takes %s for an Ordewell tool', (name) => {
    expect(OPENCODE_ORDEWELL.isOrdewellAsk(name)).toBe(true);
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
    expect(children.adopt('ses_c', 'call_1')).toEqual(['f1', 'f2']);
    expect(children.adopt('ses_c', 'call_1')).toBeNull();
    expect(children.claim('ses_c', 'f3')).toBe('call_1');
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
    const permissions = openCodePermissions(async () => {}, () => ({ role: 'planner', autoApprove: false }));
    permissions.raise({ id: 'per_1', name: 'bash', detail: '{}', ordewell: false }, { id: 'per_1', sessionId: 'ses' }, () => {});
    const how = {
      processEnded: new Promise<void>(() => {}),
      streamFailed: new Promise<never>(() => {}),
      exitMessage: () => 'The server exited.',
      readBack: async () => { order.push('readBack'); },
      permissions,
      outcome: (): AgentEvent => { order.push('outcome'); return { type: 'turn_end' }; },
      ...overrides,
    };
    return { how, order, events, onEvent: (e: AgentEvent) => events.push(e) };
  }

  it('rejects with what a frame handler threw and cancels requests that cannot finish', async () => {
    const turn = turnLatch();
    const { how, order, events, onEvent } = settlement({ streamFailed: Promise.reject(new Error('handler blew up')) });

    await expect(settleTurn(turn, how, onEvent)).rejects.toThrow('handler blew up');
    expect(order).toEqual([]);
    expect(events).toEqual([{ type: 'permission_cancelled', id: 'per_1' }]);
  });

  it('reads back, cancels what is still open, then reports the outcome', async () => {
    const turn = turnLatch();
    const { how, order, events, onEvent } = settlement();
    const settled = settleTurn(turn, how, onEvent);
    turn.finish();

    expect(await settled).toBe(true);
    expect(order).toEqual(['readBack', 'outcome']);
    expect(events).toEqual([{ type: 'permission_cancelled', id: 'per_1' }, { type: 'turn_end' }]);
  });

  it('leaves no listener behind on the caller\'s signal once the turn is settled', async () => {
    const signal = new AbortController().signal;
    const listening = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, listener: Parameters<typeof signal.addEventListener>[1], options?: AddEventListenerOptions) => { listening.add(listener); add(type, listener, options); }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, listener: Parameters<typeof signal.addEventListener>[1]) => { listening.delete(listener); remove(type, listener); }) as typeof signal.removeEventListener;

    for (let i = 0; i < 3; i++) {
      const turn = turnLatch();
      const { how, onEvent } = settlement({ signal });
      const settled = settleTurn(turn, how, onEvent);
      turn.finish();
      await settled;
    }

    expect(listening.size).toBe(0);
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
  it.each(['connect', 'status', 'body', 'read', 'end'])('fails visibly after two lost %s streams', async (fault) => {
    let attempts = 0;
    const stream = await openEventStream(async () => {
      attempts++;
      if (fault === 'connect') throw new Error('ECONNREFUSED');
      if (fault === 'status') return new Response('unavailable', { status: 503 });
      if (fault === 'body') return new Response(null);
      return new Response(new ReadableStream({ start(controller) {
        if (fault === 'read') controller.error(new Error('read failed'));
        else controller.close();
      } }));
    }, () => {});
    await tick();
    expect(attempts).toBe(2);
    await expect(stream.failed).rejects.toThrow("The OpenCode runner's event stream was lost.");
    expect(stream.broken).toBe(true);
    await expect(stream.close()).rejects.toThrow('event stream was lost');
  });

  it('reconnects once when the event stream connection fails', async () => {
    let attempts = 0;
    const frames: unknown[] = [];
    const stream = await openEventStream(async (signal) => {
      if (++attempts === 1) throw new Error('ECONNRESET');
      return sseResponse({ signal }, ['data: {"restored":true}\n\n']).response;
    }, (frame) => frames.push(frame));
    await tick();
    expect(attempts).toBe(2);
    expect(frames).toEqual([{ restored: true }]);
    await stream.close();
  });

  it('parses data frames across reads, skips lines that are none, and counts every read as activity', async () => {
    const frames: unknown[] = [];
    let activity = 0;
    let feed: ReturnType<typeof sseResponse>['stream'] | null = null;
    const { close } = await openEventStream<unknown>(async (signal) => {
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

  // A handler that throws is Ordewell's own failure, not a frame the runner
  // sent badly. Swallowing it here hides a bug as if it were one more
  // unparseable line; the caller hears it when the stream is closed.
  it('surfaces a throwing frame handler instead of swallowing it as a bad frame', async () => {
    const frames: unknown[] = [];
    const { close } = await openEventStream<{ n: number }>(
      async (signal) => sseResponse({ signal }, ['data: {"n":1}\n\n', 'data: {"n":2}\n\n']).response,
      (frame) => { frames.push(frame); if (frame.n === 1) throw new Error('handler blew up'); },
    );
    for (let i = 0; i < 10 && frames.length < 1; i++) await tick();

    await expect(close()).rejects.toThrow('handler blew up');
    expect(frames).toEqual([{ n: 1 }]);
  });

  it('fails when the server has no stream, or refuses it', async () => {
    const bodiless = await openEventStream(async () => ({ ok: true, body: null }) as unknown as Response, () => {});
    await expect(bodiless.close()).rejects.toThrow('event stream was lost');
    const refused = await openEventStream(async () => { throw new Error('ECONNREFUSED'); }, () => {});
    await expect(refused.close()).rejects.toThrow('event stream was lost');
  });

  it('retries a connection that never opens, then fails and aborts both connections', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const open = openEventStream(async (signal) => {
        signals.push(signal);
        return new Promise<Response | null>(() => {});
      }, () => {});
      let settled = false;
      void open.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      const stream = await open;
      await expect(stream.failed).rejects.toThrow('event stream was lost');
      await expect(stream.close()).rejects.toThrow('event stream was lost');
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes quietly while its reconnect is still waiting for headers', async () => {
    let connections = 0;
    let breakStream: () => void = () => {};
    let reconnectSignal: AbortSignal | undefined;
    const stream = await openEventStream(async (signal) => {
      if (++connections > 1) {
        reconnectSignal = signal;
        return new Promise<Response>(() => {});
      }
      return new Response(new ReadableStream({ start(controller) {
        breakStream = () => controller.error(new Error('socket lost'));
      } }));
    }, () => {});
    breakStream();
    await vi.waitFor(() => expect(connections).toBe(2));
    await stream.close();
    expect(reconnectSignal?.aborted).toBe(true);
    expect(stream.broken).toBe(false);
  });

  it('does not mistake an aborted read for losing the event stream', async () => {
    let connections = 0;
    const stream = await openEventStream(async (signal) => {
      connections++;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      } }));
    }, () => {});
    await stream.close();
    expect(connections).toBe(1);
    expect(stream.broken).toBe(false);
  });

  it('ends the stream on close', async () => {
    let aborted = false;
    const { close } = await openEventStream(async (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return sseResponse({ signal }).response;
    }, () => {});
    await close();
    expect(aborted).toBe(true);
  });
});

describe('openCodePlannerAsk', () => {
  const servers = ['todoist', 'todoist_beta'];

  it('reads an outside read from the request', () => {
    expect(openCodePlannerAsk('external_directory', { metadata: { filepath: '/etc/hostname', parentDir: '/etc' } }, servers))
      .toEqual({ kind: 'path', path: '/etc/hostname', directory: false });
    expect(openCodePlannerAsk('external_directory', { patterns: ['/opt/data/*'] }, servers)).toEqual({ kind: 'path', path: '/opt/data', directory: true });
  });

  it('falls back to the request\'s pattern, and takes a request that names nothing for one it cannot approve', () => {
    expect(openCodePlannerAsk('external_directory', { metadata: { parentDir: '/srv' } }, servers)).toEqual({ kind: 'path', path: '/srv', directory: true });
    expect(openCodePlannerAsk('websearch', {}, servers)).toEqual({ kind: 'other' });
    expect(openCodePlannerAsk('external_directory', {}, servers)).toEqual({ kind: 'other' });
  });

  // OpenCode sends both to a third party, Exa by default, so the policy decides them as searches (ADR-0027).
  it('reads websearch and codesearch as searches, in 1.x metadata and in 2.x resources', () => {
    const search = (query: string) => ({ kind: 'search', query, provider: 'opencode', providerLabel: expect.stringContaining('Exa') });
    expect(openCodePlannerAsk('websearch', { metadata: { query: 'hono routing', numResults: 8 }, patterns: ['hono routing'] }, servers)).toEqual(search('hono routing'));
    expect(openCodePlannerAsk('codesearch', { metadata: { query: 'zod v4 refine' } }, servers)).toEqual(search('zod v4 refine'));
    expect(openCodePlannerAsk('websearch', { patterns: ['tokio changelog'] }, servers)).toEqual(search('tokio changelog'));
  });

  it('never reads a webfetch as a fetch to approve: it follows redirects Ordewell cannot see', () => {
    expect(openCodePlannerAsk('webfetch', { metadata: { url: 'https://example.com' }, patterns: ['https://example.com'] }, servers)).toEqual({ kind: 'other' });
  });

  it('names an MCP tool by the longest server it starts with', () => {
    expect(openCodePlannerAsk('todoist_beta_find-tasks', {}, servers)).toEqual({ kind: 'mcp', scope: 'todoist_beta_find-tasks', tool: 'find-tasks', server: 'todoist_beta' });
    expect(openCodePlannerAsk('todoist_add-tasks', {}, servers)).toEqual({ kind: 'mcp', scope: 'todoist_add-tasks', tool: 'add-tasks', server: 'todoist' });
  });

  it('never takes a built-in, or a tool of a server it was not told about, for an MCP tool', () => {
    for (const name of ['bash', 'edit', 'write', 'task', 'question', 'execute', 'notebook_edit']) {
      expect(openCodePlannerAsk(name, {}, servers), name).toEqual({ kind: 'other' });
    }
  });

  it('reads bash and shell as the native shell only when the opt-in put the launcher around them (ADR-0036 N2)', () => {
    expect(openCodePlannerAsk('shell', { patterns: ['for f in *; do echo "$f"; done'] }, servers, true))
      .toEqual({ kind: 'native-shell', tool: 'shell', command: 'for f in *; do echo "$f"; done' });
    expect(openCodePlannerAsk('bash', { patterns: ['ls'] }, servers, true)).toEqual({ kind: 'native-shell', tool: 'bash', command: 'ls' });
    expect(openCodePlannerAsk('bash', {}, servers, true)).toEqual({ kind: 'native-shell', tool: 'bash' });
    expect(openCodePlannerAsk('shell', { patterns: ['ls'] }, servers)).toEqual({ kind: 'other' });
  });

  it('reads a native read as the planner\'s own read only when the read limit made it ask (ADR-0068)', () => {
    expect(openCodePlannerAsk('read', { patterns: ['src/a.ts'] }, servers, false, true)).toEqual({ kind: 'native-read', tool: 'read', pattern: 'src/a.ts' });
    for (const name of ['glob', 'grep', 'list', 'lsp']) {
      expect(openCodePlannerAsk(name, {}, servers, false, true), name).toEqual({ kind: 'native-read', tool: name });
    }
    expect(openCodePlannerAsk('read', { patterns: ['src/a.ts'] }, servers)).toEqual({ kind: 'other' });
    expect(openCodePlannerAsk('edit', {}, servers, false, true)).toEqual({ kind: 'other' });
  });

  it('has 1.x\'s read tools ask in the planner\'s config only while the read limit is on (ADR-0068)', () => {
    const permission = (readsAsk?: boolean) => (JSON.parse(OPENCODE_ORDEWELL.configContent(undefined, null, 'planner', {}, undefined, undefined, undefined, readsAsk) ?? 'null') as { permission: Record<string, string> }).permission;
    expect(permission()).toEqual(OPENCODE_PLANNER_PERMISSION);
    expect(permission(true)).toEqual({ ...OPENCODE_PLANNER_PERMISSION, read: 'ask', glob: 'ask', grep: 'ask', list: 'ask', lsp: 'ask' });
  });
});

describe('an OpenCode planner\'s web reads (ADR-0027)', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' });

  it('denies webfetch and asks about websearch and codesearch, in both versions\' policy', () => {
    expect(OPENCODE_PLANNER_PERMISSION).toMatchObject({ webfetch: 'deny', websearch: 'ask', codesearch: 'ask' });
  });

  it('tells a planner with the server to fetch through Ordewell and to search with websearch first', () => {
    const { system } = plannerSystem({ systemPrompt: 'PLAN', mcp });
    const instructions = OPENCODE_ORDEWELL.plannerInstructions();

    expect(system).toBe(`PLAN\n\n${instructions}`);
    expect(instructions).toContain('`ordewell_fetch`');
    expect(instructions.indexOf('`websearch`')).toBeGreaterThanOrEqual(0);
    expect(instructions.indexOf('`websearch`')).toBeLessThan(instructions.indexOf('`ordewell_web_search`'));
  });

  it('adds nothing to a planner without the server', () => {
    expect(plannerSystem({ systemPrompt: 'PLAN' })).toEqual({ system: 'PLAN' });
    expect(plannerSystem({ systemPrompt: '' })).toEqual({});
  });
});
