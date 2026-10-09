import { describe, it, expect, vi } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { createAiService } from '../AiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { IConfig } from '../../interfaces/IConfig';
import type { ConversationRequest } from '../AiService';
import type { ResearchProgress, ResearchStep } from '../../models/Task';
import { fakeMcpServer, fakeSpawn, fixture, openCodeFixture, planJson, scriptedAdapter, sseResponse, type FakeAgentProcess, type FakeSpawnOptions, type ScriptedReply } from './harnessTestKit';
import type { AgentEvent } from '../harness/AgentAdapter';
import { addPlannerUsage, plannerContextFill } from '../../models/Usage';
import { TurnStream } from '../replyStream';

/**
 * Harness planners, driven through the one seam the design commits to: the
 * process boundary (ADR-0009). Every test here feeds recorded agent output
 * through an injected spawn and asserts what a surface would actually see —
 * the returned {@link ConversationTurn} and the emitted
 * {@link ResearchProgress} stream. Nothing reaches into adapter parse state.
 */

function service(
  provider: IConfig['aiProvider'],
  replies: ScriptedReply[],
  overrides: Partial<IConfig> = {},
  spawnOptions: FakeSpawnOptions = {},
) {
  const spawned = fakeSpawn(replies, spawnOptions);
  const config = fakeConfig({ aiProvider: provider, ...overrides });
  const svc = new CliAgentAiService(
    config,
    {
      spawn: spawned.spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      workspaceRoot: () => '/repo',
      // Pinned, not inherited: Codex's sandbox probe is Linux-only, and these
      // assertions must hold on whatever host runs the suite.
      platform: 'linux',
      // These tests exercise the fake process boundary, not the real
      // filesystem — the workspace and the agent binary are both fictional.
      isDirectory: () => true,
      exists: () => true,
      mcpServer: fakeMcpServer(),
    },
  );
  return { svc, spawned, config };
}

function request(overrides: Partial<ConversationRequest> = {}): ConversationRequest {
  const progress: ResearchProgress[] = [];
  return {
    goal: 'Add a cache layer',
    runners: ['claude-code'],
    modelsByRunner: { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
    fs: fakeFileSystem(),
    onProgress: (p) => progress.push(p),
    plannerTools: { sessionId: 's1', handler: {} },
    ...overrides,
  };
}

/** What the service wrote to the agent, past the attach check a planner given tools opens with. */
function writes(proc: FakeAgentProcess): string[] {
  return proc.written.filter((line) => !line.includes('"subtype":"mcp_status"'));
}

function collector() {
  const events: ResearchProgress[] = [];
  return { events, onProgress: (p: ResearchProgress) => events.push(p) };
}

/** Codex needs its two handshake replies before any turn can be scripted. */
function codexHandshake(): ScriptedReply[] {
  return [fixture('codex', 'handshake'), fixture('codex', 'new-conversation')];
}

describe('CliAgentAiService — Claude Code', () => {
  it('returns the agent prose reply as a message turn', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'prose')]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('in-process or Redis');
  });

  it('spawns read-only: plan permission mode, write tools disallowed', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    const args = spawned.lastArgs();
    expect(spawned.lastCommand()).toBe('claude');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    const disallowed = args[args.indexOf('--disallowedTools') + 1];
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Edit');
  });

  it('passes the planner model and effort from config', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')], {
      orchestratorModel: 'haiku',
      plannerThinkingEffort: 'low',
    });
    await svc.startConversation(request());

    const args = spawned.lastArgs();
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
  });

  it('sends no --effort for adaptive, which the flag does not accept', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')], {
      orchestratorModel: 'opus',
      plannerThinkingEffort: 'adaptive',
    });
    await svc.startConversation(request());

    expect(spawned.lastArgs()).not.toContain('--effort');
  });

  it('maps agent tools onto the research vocabulary, keeping unknown ones honest', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'tools')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((c) => c.tool)).toEqual(['read_file', 'grep', 'fetch']);
    // The agent's own name survives the mapping — no surface has to guess.
    expect(calls.map((c) => c.toolLabel)).toEqual(['Read', 'Grep', 'WebFetch']);
  });

  it('matches each result to its own call by id, not by tool name', async () => {
    // The fixture returns results out of order on purpose: grep, then the
    // failed fetch, then read. Name-matching would put the grep hit on the
    // read's row.
    const { svc } = service('claude-code', [fixture('claude-code', 'tools')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    const byId = new Map(events.filter((e) => e.type === 'tool_result').map((e) => [e.toolCallId, e.step!]));
    expect(byId.get('toolu_read')!.tool).toBe('read_file');
    expect(byId.get('toolu_read')!.result).toContain('# Ordewell');
    expect(byId.get('toolu_grep')!.tool).toBe('grep');
    expect(byId.get('toolu_grep')!.result).toContain('createAiService');
    expect(byId.get('toolu_fetch')!.outcome).toBe('failure');
  });

  it('emits the agent thinking where the model exposes it', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'tools')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toContain('read the README');
  });

  // Claude Code replays a subagent's whole transcript on the planner's own
  // stream, parented to the tool call that spawned it. Read as the planner
  // talking, an exploration agent's commentary became the first thing the user
  // saw — an answer to a prompt they never sent.
  it('keeps subagent text out of the planner reply, and tags its steps with the subagent', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'subagent')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.text).not.toContain('Tool loaded');
    expect(turn.text).toContain('explore the cache layer');
    expect(turn.text).toContain('in-process or Redis');
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.subagentId)).toEqual(['toolu_agent']);
    // Only the spawning call is the planner's; the subagent's own Read is its.
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((c) => [c.toolCallId, c.subagentId])).toEqual([['toolu_agent', undefined], ['toolu_sub_read', 'toolu_agent']]);
    expect(turn.researchLog.flatMap((s) => ('toolCallId' in s ? [[s.toolCallId, s.subagentId]] : []))).toEqual([
      ['toolu_sub_read', 'toolu_agent'],
      ['toolu_agent', undefined],
    ]);
  });

  // A VS Code idle watchdog resets on any progress event reaching the
  // webview. Some lines — a subagent's prompt, its commentary, init and
  // status chatter — yield no event at all; if liveness rode along with
  // events alone, a long stretch of them would starve the watchdog and it
  // would report a false "stopped responding" while the CLI was still working.
  it('pings liveness on every raw line, including the ones that yield no event', async () => {
    const recorded = fixture('claude-code', 'stream-subagent');
    const { svc } = service('claude-code', [recorded]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    const lines = recorded.split('\n').filter((l) => l.trim()).length;
    expect(events.filter((e) => e.type === 'liveness').length).toBeGreaterThanOrEqual(lines);
  });

  it('opens a paragraph for each message after the first, instead of running them together', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'subagent')]);
    const turn = await svc.startConversation(request());

    expect(turn.text).toBe(
      'I\'ll explore the cache layer in parallel.\n\nThat agent returned the answer: should the cache be in-process or Redis?',
    );
  });

  it('commits a plan emitted as text through the existing parser', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'plan', { PLAN: planJson() })]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('plan');
    if (turn.kind !== 'plan') throw new Error('expected a plan');
    expect(turn.tasks).toHaveLength(1);
    expect(turn.tasks[0].title).toBe('Add the thing');
    // A committed plan closes the conversation, like the API backend.
    expect(svc.hasActiveConversation()).toBe(false);
  });

  // The read channel is a text envelope precisely so it works here, where
  // Ordewell owns no tool loop to register a tool on (ADR-0009).
  it('hands a task-query read up as its own turn kind', async () => {
    const query = JSON.stringify({ taskQuery: { tasks: ['#2'], catalog: true } });
    const { svc } = service('claude-code', [fixture('claude-code', 'plan', { PLAN: query })]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('task_query');
    if (turn.kind !== 'task_query') throw new Error('expected a read');
    expect(turn.query.tasks).toEqual(['#2']);
    expect(turn.query.catalog).toBe(true);
    // A read settles nothing, so the conversation stays open for the answer.
    expect(svc.hasActiveConversation()).toBe(true);
  });

  // Claude Code auto-backgrounds an `Agent` call and ends the turn on "I'll
  // report back once they land". Its turn ending is what hands the conversation
  // back to the user, so the report — the whole point of the research — arrives
  // with no turn open and reaches nobody. The planner is asked to wait instead.
  it('waits for a backgrounded agent instead of settling on "I\'ll report back"', async () => {
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'async-agent'),
      fixture('claude-code', 'async-agent-report'),
    ]);
    const turn = await svc.startConversation(request());

    expect(turn.text).toContain('KPI helpers live in lib/kpis.py');
    const sent = writes(spawned.processes[0]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('background');
  });

  // The wait is Ordewell's doing, not a new user message, so the reply the user
  // reads must be the whole answer — what the planner said before delegating,
  // and what it found. Returning only the last turn would trade one lost half
  // of the conversation for the other.
  it('keeps what the planner said before the wait, not just the report', async () => {
    const { svc } = service('claude-code', [
      fixture('claude-code', 'async-agent'),
      fixture('claude-code', 'async-agent-report'),
    ]);
    const turn = await svc.startConversation(request());

    expect(turn.text).toContain('explore the dashboard and the data layer');
    expect(turn.text).toContain('KPI helpers live in lib/kpis.py');
  });

  // A planner that answers every wait by backgrounding another agent must cost
  // a known number of turns, not an open-ended poll against a user who is
  // watching a spinner.
  it('gives up waiting after a bounded number of asks', async () => {
    const deferring = fixture('claude-code', 'async-agent');
    const { svc, spawned } = service('claude-code', [deferring, deferring, deferring, deferring]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    // One goal + two waits, then it stops asking.
    expect(writes(spawned.processes[0])).toHaveLength(3);
  });

  // Work that lands after a turn closed — a backgrounded agent finishing, a
  // straggling read — belongs to the turn that asked for it. Held and replayed
  // into the next one, it reads as research the planner did for the user's new
  // message, and the file it names has nothing to do with what they just asked.
  it('does not replay a closed turn\'s tool activity into the next turn', async () => {
    const { svc } = service('claude-code', [
      fixture('claude-code', 'late-tools'),
      fixture('claude-code', 'prose'),
    ]);
    await svc.startConversation(request());
    const { events, onProgress } = collector();
    const turn = await svc.continueConversation('Redis, please.', onProgress);

    expect(turn.researchLog).toHaveLength(0);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
  });

  it('repairs a botched plan with a bounded corrective re-emit', async () => {
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'broken-plan'),
      fixture('claude-code', 'plan', { PLAN: planJson() }),
    ]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('plan');
    // Two user messages went in: the goal, then the corrective re-emit. The
    // fixture's plan is cut off mid-object, so the re-emit asks for a terser
    // plan, as on the API backend — and claims no trim, since the agent's
    // context is its own.
    const sent = writes(spawned.processes[0]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('cut off by the output length limit');
    expect(sent[1]).not.toContain('trimmed');
  });

  it('degrades to prose when the repair budget is exhausted', async () => {
    const broken = fixture('claude-code', 'broken-plan');
    const { svc, spawned } = service('claude-code', [broken, broken, broken]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    // One goal + two corrective re-emits, then it stops asking.
    expect(writes(spawned.processes[0])).toHaveLength(3);
  });

  it('denies any permission the agent asks for and records it as denied', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'permission')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    const denied = events.find((e) => e.type === 'tool_result' && e.step?.outcome === 'denied');
    expect(denied?.step?.toolLabel).toBe('Write');
    expect(denied?.step?.result).toContain('read-only');
    // The refusal is answered on the control channel, or the agent stalls.
    expect(spawned.processes[0].written.join('')).toContain('"behavior":"deny"');
    expect(turn.kind).toBe('message');
  });

  it('surfaces a mid-turn process death as a visible chat error', async () => {
    const { svc } = service('claude-code', [
      (_written, proc) => {
        proc.emitStderr('Credit balance is too low');
        proc.exit(1);
      },
    ]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('exited with code 1');
    expect(turn.text).toContain('Credit balance is too low');
  });

  it('reuses one process across turns instead of respawning', async () => {
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'prose'),
      fixture('claude-code', 'prose'),
    ]);
    await svc.startConversation(request());
    await svc.continueConversation('Redis, please', () => {});

    expect(spawned.processes).toHaveLength(1);
    expect(writes(spawned.processes[0])).toHaveLength(2);
  });

  it('kills the agent process on reset', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());
    svc.reset();

    expect(spawned.processes[0].killed).toBe(true);
    expect(svc.hasActiveConversation()).toBe(false);
  });

  it('replays a persisted transcript instead of re-running research', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request({
      priorHistory: [
        { role: 'user', content: 'Add a cache layer', timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: 'Which store?', timestamp: '2026-01-01T00:00:01Z' },
      ],
      initialMessage: 'In-process is fine',
    }));

    const opening = writes(spawned.processes[0])[0];
    expect(opening).toContain('previous_conversation');
    expect(opening).toContain('Which store?');
    expect(opening).toContain('In-process is fine');
  });

  it('stops the agent when the turn is aborted', async () => {
    const controller = new AbortController();
    const { svc, spawned } = service('claude-code', [
      () => { controller.abort(); },
    ]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, signal: controller.signal }));

    expect(events.some((e) => e.type === 'interrupted')).toBe(true);
    expect(spawned.processes[0].killed).toBe(true);
    expect(turn.kind).toBe('message');
  });

  // Each turn links its own stop to the caller's signal. A caller aborting a
  // signal it gave a turn that already ended must not stop the turn running now.
  it('leaves the running turn alone when a finished turn\'s signal is aborted', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    let release = () => {};
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      workspaceRoot: () => '/repo',
      mcpServer: fakeMcpServer(),
      createAdapter: () => ({
        agentId: 'claude-code',
        start: async () => {},
        nativeSessionId: () => null,
        dispose: () => {},
        mcpAttached: async () => true,
        send: async (_message, onEvent, signal) => {
          signals.push(signal);
          if (signals.length === 2) await new Promise<void>((resolve) => { release = resolve; });
          onEvent({ type: 'assistant_text', text: 'ok' });
          onEvent({ type: 'turn_end' });
        },
      }),
    });
    const finished = new AbortController();
    await svc.startConversation(request({ signal: finished.signal }));
    const running = svc.continueConversation('next', () => {}, new AbortController().signal);
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    finished.abort();

    expect(signals[1]?.aborted).toBe(false);
    release();
    expect(await running).toMatchObject({ kind: 'message', text: 'ok' });
  });

  it('restarts from the agent session after a stop, rather than writing into a killed process', async () => {
    // Stop kills the process by contract, and `dispose()` is terminal. Reusing
    // the same adapter for the next message threw instead of answering.
    const controller = new AbortController();
    const { svc, spawned } = service('claude-code', [
      (_written, proc) => {
        proc.emitStdout('{"type":"system","subtype":"init","session_id":"sess-claude-1"}\n');
        controller.abort();
      },
      fixture('claude-code', 'prose'),
    ]);
    await svc.startConversation(request({ signal: controller.signal }));
    const turn = await svc.continueConversation('Carry on', () => {});

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('in-process or Redis');
    expect(spawned.processes).toHaveLength(2);
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-claude-1');
  });

  it('names the refused tool when the agent ends its turn without replying', async () => {
    // Agents can stop on a refusal and say nothing. "Empty reply" told the user
    // nothing they could act on; the denial is the actual reason.
    const denialOnly = [
      '{"type":"system","subtype":"init","session_id":"sess-claude-9"}',
      '{"type":"control_request","request_id":"req_09","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/etc/hosts"}}}',
      '{"type":"result","subtype":"success","session_id":"sess-claude-9","is_error":false,"result":""}',
      '',
    ].join('\n');
    // The control-channel denial is itself a write, so replies are keyed to the
    // user turns rather than to the write count.
    const onUserTurn: ScriptedReply = (written, proc) => {
      if (written.includes('"type":"user"')) proc.emitStdout(denialOnly);
    };
    const { svc } = service('claude-code', [onUserTurn, onUserTurn, onUserTurn, onUserTurn]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('Write');
    expect(turn.text).toContain('read-only');
  });
});

describe('CliAgentAiService — streamed events (#47)', () => {
  function scripted(...turns: AgentEvent[][]) {
    return new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      createAdapter: scriptedAdapter(turns),
      workspaceRoot: () => '/repo',
      mcpServer: fakeMcpServer(),
    });
  }

  it('streams reply deltas once, and takes the complete text as authoritative', async () => {
    const svc = scripted([
      { type: 'assistant_text_delta', text: 'Which ' },
      { type: 'assistant_text_delta', text: 'stor' },
      { type: 'assistant_text', text: 'Which store?' },
      { type: 'turn_end' },
    ]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.text).toBe('Which store?');
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.map((e) => e.text)).toEqual(['Which ', 'stor']);
    expect(new Set(deltas.map((e) => e.segmentId)).size).toBe(1);
  });

  it('reads as chat text through a real TurnStream, never the "building" plan display', async () => {
    // Regression: assistant text used to bypass TurnStream's classifier
    // entirely, so every harness reply — plain prose included — rendered as
    // "Building plan…" until the turn settled (#48).
    const svc = scripted([
      { type: 'assistant_text_delta', text: 'Which ' },
      { type: 'assistant_text_delta', text: 'store?' },
      { type: 'assistant_text', text: 'Which store?' },
      { type: 'turn_end' },
    ]);
    const routed: ResearchProgress[] = [];
    const stream = new TurnStream('t1', (p) => routed.push(p));

    const turn = await svc.startConversation(request({ onProgress: stream.sink() }));

    expect(turn.text).toBe('Which store?');
    expect(routed.filter((e) => e.type === 'plan_token')).toEqual([]);
    expect(routed.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['Which ', 'store?']);
  });

  it('keeps the text streamed before a tool call when a later run completes', async () => {
    const svc = scripted([
      { type: 'assistant_text_delta', text: 'Let me look. ' },
      { type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 'c1', name: 'Read', output: 'x', success: true },
      { type: 'assistant_text_delta', text: 'Found it.' },
      { type: 'assistant_text', text: 'Found it.' },
      { type: 'turn_end' },
    ]);

    const turn = await svc.startConversation(request());

    expect(turn.text).toBe('Let me look. Found it.');
  });

  it('tags subagent activity with its subagent and keeps it out of the reply', async () => {
    const svc = scripted([
      { type: 'assistant_text', text: 'Delegating. ' },
      { type: 'tool_call', id: 'task-1', name: 'Task', args: { prompt: 'find the cache' } },
      { type: 'thinking_delta', text: 'grep ', subagentId: 'sa1' },
      { type: 'thinking', text: 'grep first', subagentId: 'sa1' },
      { type: 'tool_call', id: 'c1', name: 'Grep', args: { pattern: 'cache' }, subagentId: 'sa1' },
      { type: 'tool_result', id: 'c1', name: 'Grep', output: 'src/cache.ts', success: true, subagentId: 'sa1' },
      { type: 'tool_result', id: 'task-1', name: 'Task', output: 'It is in src/cache.ts', success: true },
      { type: 'assistant_text_delta', text: 'It is in src/cache.ts.' },
      { type: 'turn_end' },
    ]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.text).toBe('Delegating. It is in src/cache.ts.');
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.map((e) => e.text)).toEqual(['Delegating. ', 'It is in src/cache.ts.']);
    // The subagent's Task call commits the planner's run, so its reply after
    // the call is a fresh segment — never the same one the delegation opened.
    expect(deltas[0].segmentId).not.toBe(deltas[1].segmentId);
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'grep ', subagentId: 'sa1' }]);
    expect(events.find((e) => e.type === 'tool_call' && e.toolCallId === 'c1')?.subagentId).toBe('sa1');
    expect(events.find((e) => e.type === 'tool_result' && e.toolCallId === 'c1')?.subagentId).toBe('sa1');
    const steps = turn.researchLog.filter((e): e is ResearchStep => !('type' in e));
    expect(steps.map((step) => [step.toolCallId, step.subagentId])).toEqual([['c1', 'sa1'], ['task-1', undefined]]);
  });

  it('takes back an attempt the JSON repair discards before the corrected re-emit', async () => {
    const broken = '{"tasks":[{"id":"t1","order":1,"title":"A","description":"d","type":"ai","dependencies":[],"subtasks":[]}]}';
    const svc = scripted(
      [{ type: 'assistant_text', text: broken }, { type: 'turn_end' }],
      [{ type: 'assistant_text', text: planJson() }, { type: 'turn_end' }],
    );
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.kind).toBe('plan');
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_retracted', 'text_delta']);
  });

  it('takes back what an empty reply streamed before nudging the agent', async () => {
    const svc = scripted(
      [{ type: 'assistant_text_delta', text: '\n' }, { type: 'assistant_text', text: '' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', text: 'Which store?' }, { type: 'turn_end' }],
    );
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.text).toBe('Which store?');
    // First: the empty reply's own deltas taken back before the nudge. Second:
    // the successful reply's single segment, retracted again so its settled
    // bubble does not sit next to a leftover streamed copy of itself.
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_retracted', 'text_delta', 'text_retracted']);
  });

  it('reports subagent lifecycle and usage, the subagent\'s share carried on its finish', async () => {
    const svc = scripted([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'find the cache', model: 'haiku' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 300, outputTokens: 20, subagentId: 'sa1' } },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 100, subagentId: 'sa1' } },
      { type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 5000, outputTokens: 80, reportedCost: { amount: 0.04, currency: 'USD' } } },
      { type: 'assistant_text', text: 'It is in src/cache.ts.' },
      { type: 'turn_end' },
    ]);
    const { events, onProgress } = collector();

    await svc.startConversation(request({ onProgress }));

    expect(events.filter((e) => e.type !== 'plan_token' && e.type !== 'text_delta' && e.type !== 'text_retracted')).toEqual([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'find the cache', model: 'haiku' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 300, outputTokens: 20, subagentId: 'sa1' } },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 100, subagentId: 'sa1' } },
      { type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts', usage: { inputTokens: 400, outputTokens: 20 } },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 5000, outputTokens: 80, reportedCost: { amount: 0.04, currency: 'USD' } } },
    ]);
  });

  // Agents restate a subagent's state as it changes — a tool part updated,
  // a later call listing every child's status — and one may finish in a later
  // turn than it started in. Surfaces get one start and one finish, in order.
  it('reports each subagent starting once and finishing once, across turns, and never a finish without a start', async () => {
    const started = { type: 'subagent_started', subagentId: 'sa1', brief: 'find the cache' } as const;
    const finished = { type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts' } as const;
    const svc = scripted(
      [started, started, { type: 'assistant_text', text: 'Looking.' }, { type: 'turn_end' }],
      [finished, started, finished, { type: 'subagent_finished', subagentId: 'ghost', outcome: 'failed', digest: '' }, { type: 'assistant_text', text: 'Found it.' }, { type: 'turn_end' }],
    );
    const { events, onProgress } = collector();

    await svc.startConversation(request({ onProgress }));
    await svc.continueConversation('go on', onProgress);

    expect(events.filter((e) => e.type === 'subagent_started' || e.type === 'subagent_finished').map((e) => `${e.type}:${e.subagentId}`))
      .toEqual(['subagent_started:sa1', 'subagent_finished:sa1']);
  });
});

describe('CliAgentAiService — Codex', () => {
  it('handshakes, then reports exploration and prose from its event stream', async () => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('src/services/AiService.ts');
    // `shell` is Codex's command tool by another name — it maps onto `bash`.
    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.tool).toBe('bash');
    expect(events.find((e) => e.type === 'tool_result')?.step?.outcome).toBe('success');
    // The thread is opened read-only, with approvals never asked for.
    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.method).toBe('thread/start');
    expect(threadStart.params.sandbox).toBe('read-only');
    expect(threadStart.params.approvalPolicy).toBe('never');
  });

  it('flattens reasoning blocks and drops the empty ones the real CLI emits', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'tools')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    // `reasoning.summary` is an array of blocks, and Codex emits an empty one
    // before the real one — reading it as a string produced blank thinking.
    const thinking = events.filter((e) => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toBe('Checking how the planner is wired.');
  });

  it('commits a plan emitted in an agent_message', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'plan', { PLAN: planJson('codex') })]);
    const turn = await svc.startConversation(request({ runners: ['codex'] }));

    expect(turn.kind).toBe('plan');
  });

  it('declines a file-change approval rather than letting the planner write', async () => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'approval')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    expect(events.find((e) => e.type === 'tool_result' && e.step?.outcome === 'denied')).toBeDefined();
    // `decline`, not `cancel`: the agent keeps planning without what it asked for.
    expect(spawned.processes[0].written.join('')).toContain('"decision":"decline"');
  });

  it('fails visibly when the app-server never completes its handshake', async () => {
    const { svc } = service('codex', [
      (_written, proc) => {
        proc.emitStderr('error: unrecognized subcommand `app-server`');
        proc.exit(2);
      },
    ]);

    await expect(svc.startConversation(request({ runners: ['codex'] })))
      .rejects.toThrow(/handshake|app-server/i);
  });

  it('layers its instructions on top of Codex\'s own prompt instead of replacing it', async () => {
    // `baseInstructions` replaces the base prompt, taking Codex's description
    // of its own tools with it — a planner that has forgotten it can read the
    // workspace answers from a web search instead.
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools')]);
    await svc.startConversation(request({ runners: ['codex'] }));

    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.params.developerInstructions).toContain('USER GOAL: Add a cache layer');
    expect(threadStart.params.baseInstructions).toBeUndefined();
  });

  it('answers every server request, including the ones it has no result schema for', async () => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'server-requests')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    const answers = spawned.processes[0].written
      .map((line) => JSON.parse(line))
      .filter((msg) => typeof msg.id === 'number' && msg.id >= 9000);
    expect(answers.map((a) => a.id).sort()).toEqual([9101, 9102, 9103]);
    // A clock read is not a capability request: answering it beats failing a
    // tool for no reason.
    expect(answers.find((a) => a.id === 9101).result.currentTimeAt).toBeGreaterThan(0);
    // A question for a user who is not watching, and a permission grant, are
    // both refused — with an error, because neither result schema can say "no".
    expect(answers.find((a) => a.id === 9102).error.message).toContain('read-only');
    expect(answers.find((a) => a.id === 9103).error.message).toContain('read-only');
    expect(answers.find((a) => a.id === 9103).result).toBeUndefined();

    const denied = events.filter((e) => e.type === 'tool_result' && e.step?.outcome === 'denied');
    expect(denied.map((e) => e.step!.toolLabel)).toEqual(['requestUserInput', 'requestApproval']);
    expect(turn.kind).toBe('message');
  });

  it('opens a paragraph between the several whole messages one turn emits', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'two-messages')]);
    const turn = await svc.startConversation(request({ runners: ['codex'] }));

    expect(turn.text).toBe('I am reading the pricing module.\n\napplyDiscount has no tests. Shall I plan them?');
  });

  it('surfaces the startup warning that explains a planner which cannot read the workspace', async () => {
    const { svc } = service('codex', [
      fixture('codex', 'handshake-warning'),
      fixture('codex', 'new-conversation'),
      fixture('codex', 'tools'),
    ]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    // The warning arrives during the handshake, before any turn exists to show
    // it in. Dropping it left a silently blind planner.
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text).join('\n'))
      .toContain('bubblewrap');
  });

  it('plans under the legacy Landlock backend when bubblewrap cannot start', async () => {
    const { svc, spawned } = service(
      'codex',
      [fixture('codex', 'handshake-warning'), fixture('codex', 'new-conversation'), fixture('codex', 'tools')],
      {},
      { probe: (args) => (args.includes('use_legacy_landlock') ? { code: 0 } : { code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR' }) },
    );
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.params.config.features).toEqual({ use_legacy_landlock: true });
    expect(threadStart.params.sandbox).toBe('read-only');
    // Codex emits the bubblewrap warning from its default config regardless.
    // Passed through it is a false alarm; the replacement says what actually
    // happened and how to repair the host, since Landlock is deprecated.
    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.text).join('\n');
    expect(thinking).toContain('legacy Landlock backend');
    expect(thinking).toContain('apparmor_restrict_unprivileged_userns=0');
  });

  it('refuses to plan blind when no sandbox backend works', async () => {
    const { svc } = service(
      'codex',
      codexHandshake(),
      {},
      { probe: () => ({ code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }) },
    );

    // A Codex that can run no command still answers — from memory. Failing here
    // is the fail-safe: a visible failure instead of a confident blind plan.
    await expect(svc.startConversation(request({ runners: ['codex'] })))
      .rejects.toThrow(/apparmor_restrict_unprivileged_userns/);
  });

  it('ends the turn on a non-retryable error rather than waiting for a completion that never comes', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'error-fatal')]);
    const turn = await svc.startConversation(request({ runners: ['codex'] }));

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('usage limit');
  });

  it('does not let the completion trailing a failed turn settle the next one', async () => {
    // The failed turn ends on `error`, and the `turn/completed` behind it lands
    // with no turn to belong to. Carrying it forward answered the user's next
    // message with silence.
    const { svc } = service('codex', [
      ...codexHandshake(),
      fixture('codex', 'error-fatal'),
      fixture('codex', 'handshake'),
      fixture('codex', 'new-conversation'),
      fixture('codex', 'tools'),
    ]);
    await svc.startConversation(request({ runners: ['codex'] }));
    const turn = await svc.continueConversation('Try again', () => {});

    expect(turn.text).toContain('Which surface should I start from?');
  });

  it('lets a retryable error pass, because the turn is still running', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'error-retry')]);
    const turn = await svc.startConversation(request({ runners: ['codex'] }));

    expect(turn.text).toContain('Which module should I plan for?');
  });

  it('resumes the thread it already paid to fill when the process is gone', async () => {
    const controller = new AbortController();
    const { svc, spawned } = service('codex', [
      ...codexHandshake(),
      () => { controller.abort(); },
      fixture('codex', 'handshake'),
      fixture('codex', 'new-conversation'),
      fixture('codex', 'tools'),
    ]);
    await svc.startConversation(request({ runners: ['codex'], signal: controller.signal }));
    await svc.continueConversation('Carry on', () => {});

    const resume = JSON.parse(spawned.processes[1].written[1]);
    expect(resume.method).toBe('thread/resume');
    expect(resume.params.threadId).toBe('thr-codex-1');
    expect(resume.params.sandbox).toBe('read-only');
  });

  it('falls back to a fresh thread when the resume is rejected', async () => {
    const controller = new AbortController();
    const { svc, spawned } = service('codex', [
      ...codexHandshake(),
      () => { controller.abort(); },
      fixture('codex', 'handshake'),
      fixture('codex', 'resume-rejected'),
      // The fallback is the connection's third request, so Codex answers it under id 3.
      fixture('codex', 'new-conversation').replace('"id":2,', '"id":3,'),
      fixture('codex', 'tools'),
    ]);
    await svc.startConversation(request({ runners: ['codex'], signal: controller.signal }));
    const turn = await svc.continueConversation('Carry on', () => {});

    const methods = spawned.processes[1].written.map((line) => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'thread/resume', 'thread/start', 'turn/start']);
    expect(turn.kind).toBe('message');
  });

  it('streams reply and reasoning deltas without double counting the completed items', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'deltas')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    // The completed agentMessage repeats what already streamed; it replaces the
    // deltas, it does not append them.
    expect(turn.text).toBe('Which store?');
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['Which ', 'store?']);
    // Same for reasoning: the completed item's summary repeats the streamed one.
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text))
      .toEqual(['Checking how ', 'the planner is wired.']);
  });

  it('reports one usage record per model call, never the cumulative thread total', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'usage')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    const usage = events.flatMap((e) => (e.type === 'usage' && e.record ? [e.record] : []));
    // The turn made two model calls; `last` is each call, `total` is the thread.
    expect(usage.map((r) => r.inputTokens)).toEqual([13232, 13374]);
    expect(usage.map((r) => r.outputTokens)).toEqual([113, 10]);
    expect(usage.map((r) => r.cachedInputTokens)).toEqual([9984, 9984]);
    // `total` for the turn is 26606 — the sum of the two `last` values. Emitting
    // it each update would count the first call twice.
    expect(usage.some((r) => r.inputTokens === 26606)).toBe(false);
    const first = usage[0];
    expect(first?.contextWindow).toBe(258400);
    expect(first?.model).toBe('gpt-5.6-sol');
    // Codex reports no price.
    expect(first?.reportedCost).toBeUndefined();
    expect(first?.subagentId).toBeUndefined();
  });

  it('keeps a subagent\'s words out of the reply and tags its work', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'subagent')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    expect(turn.text).toBe(
      "I'll delegate the file-reading task to a subagent, then wait for its report.\n\nThe subagent read the file and found the number 42.",
    );
    expect(turn.text).not.toContain('SUBAGENT-ONLY-TEXT');

    const started = events.find((e) => e.type === 'subagent_started');
    expect(started).toMatchObject({
      subagentId: 'thr-codex-sub1',
      brief: 'Read /repo/notes.txt and report its contents.',
      model: 'gpt-5.6-luna',
    });

    const finished = events.find((e) => e.type === 'subagent_finished');
    expect(finished).toMatchObject({
      subagentId: 'thr-codex-sub1',
      outcome: 'done',
      digest: 'I read the file; the number is 42. SUBAGENT-ONLY-TEXT',
    });

    // The subagent's own tool call reaches the timeline tagged with its id.
    const subStep = events.find((e) => e.type === 'tool_result' && e.subagentId === 'thr-codex-sub1');
    expect(subStep?.toolCallId).toBe('item_sc1');

    // Its model call counts toward the total but is attributed to the subagent,
    // and its window says nothing about the planner's own context.
    const subUsage = events.flatMap((e) => (e.type === 'usage' && e.record ? [e.record] : [])).find((r) => r.subagentId === 'thr-codex-sub1');
    expect(subUsage).toMatchObject({ inputTokens: 13944, outputTokens: 99, cachedInputTokens: 9984 });
    expect(subUsage?.contextWindow).toBeUndefined();

    // Restated at every status change on the wire; reported once.
    expect(events.filter((e) => e.type === 'subagent_started' || e.type === 'subagent_finished').map((e) => e.type)).toEqual(['subagent_started', 'subagent_finished']);
  });
});

/**
 * OpenCode is the one agent whose transport is a server rather than a stdio
 * protocol, so its half of the seam is the injected `fetch`. The process is
 * still spawned through the same injected `spawn` — it just answers over HTTP
 * once its banner names a port.
 */
describe('CliAgentAiService — OpenCode', () => {
  /**
   * `sseFrames`, when given, makes `/event` a real stream: the frames are
   * delivered before the message POST resolves, which is where the server
   * raises its permission requests. Omitted, `/event` answers with no body —
   * the shape a server too old to stream produces.
   */
  function openCodeService(routes: (url: string, init?: RequestInit) => unknown, sseFrames?: string[]) {
    const spawned = fakeSpawn([]);
    const originalSpawn = spawned.spawn;
    const spawn: typeof originalSpawn = (cmd, argv, opts) => {
      const proc = originalSpawn(cmd, argv, opts);
      // The server announces its address on stdout before it accepts requests.
      queueMicrotask(() => spawned.processes[spawned.processes.length - 1].emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
      return proc;
    };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      // A 1.x server has no `/api/info`; the adapter's probe for 2.x gets an answer with no version, off the routes.
      if (url.endsWith('/api/info')) return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as unknown as Response;
      if (url.endsWith('/mcp')) return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ordewell: { status: 'connected' } }) } as unknown as Response;
      const body = routes(url, init);
      if (url.endsWith('/event')) {
        if (!sseFrames) return { ok: true, status: 200, statusText: 'OK', body: null } as unknown as Response;
        return sseResponse(init, sseFrames).response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const svc = new CliAgentAiService(
      fakeConfig({ aiProvider: 'opencode', enabledRunners: ['opencode'] }),
      { spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', workspaceRoot: () => '/repo', isDirectory: () => true, exists: () => true, mcpServer: fakeMcpServer() },
    );
    return { svc, spawned };
  }

  // One OpenCode message can carry text on both sides of a tool call. Run
  // together they read as one broken sentence ("…let me check.The factory is…"),
  // the same way Claude Code's and Codex's did before each grew a separator.
  it('opens a paragraph for a second text part instead of running them together', async () => {
    const { svc } = openCodeService((url) => {
      if (url.endsWith('/session')) return { id: 'ses_parts' };
      return {
        info: { id: 'msg_a' },
        parts: [
          { id: 'prt_1', messageID: 'msg_a', type: 'text', text: 'Let me check where the factory lives.' },
          { id: 'prt_2', messageID: 'msg_a', type: 'tool', tool: 'grep', callID: 'call_1', state: { status: 'completed', input: { pattern: 'createAiService' }, output: 'AiService.ts:137' } },
          { id: 'prt_3', messageID: 'msg_a', type: 'text', text: 'The factory is in AiService.ts. Ready to plan?' },
        ],
      };
    });

    const turn = await svc.startConversation(request({ runners: ['opencode'] }));

    expect(turn.text).toBe('Let me check where the factory lives.\n\nThe factory is in AiService.ts. Ready to plan?');
  });

  it('creates a session, sends the turn to the plan agent, and reports tool parts', async () => {
    const seen: { url: string; body?: unknown }[] = [];
    const { svc } = openCodeService((url, init) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/session')) return { id: 'ses_opencode_1' };
      return {
        info: { id: 'msg_a' },
        parts: [
          { id: 'prt_1', messageID: 'msg_a', type: 'tool', tool: 'grep', callID: 'call_1', state: { status: 'completed', input: { pattern: 'createAiService' }, output: 'AiService.ts:137' } },
          { id: 'prt_2', messageID: 'msg_a', type: 'text', text: 'The factory is in AiService.ts. Ready to plan?' },
        ],
      };
    });

    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['opencode'] }));

    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('Ready to plan?');
    const message = seen.find((s) => s.url.includes('/message'))!.body as { agent: string };
    // The read-only guarantee for this agent: its own plan agent has no write tools.
    expect(message.agent).toBe('plan');
    const call = events.find((e) => e.type === 'tool_call');
    expect(call?.tool).toBe('grep');
    expect(events.find((e) => e.type === 'tool_result')?.step?.outcome).toBe('success');
  });

  it('commits a plan carried in a text part', async () => {
    const { svc } = openCodeService((url) => {
      if (url.endsWith('/session')) return { id: 'ses_opencode_2' };
      return { info: { id: 'msg_a' }, parts: [{ id: 'prt_1', messageID: 'msg_a', type: 'text', text: planJson('opencode') }] };
    });

    const turn = await svc.startConversation(request({ runners: ['opencode'] }));
    expect(turn.kind).toBe('plan');
  });

  it('never lets the echoed user message into the planner reply', async () => {
    // The server replays the user's own message back as text parts. Letting
    // those through put the goal into the reply text — and a goal that quotes
    // JSON would then be parsed as the plan.
    const { svc } = openCodeService((url) => {
      if (url.endsWith('/session')) return { id: 'ses_opencode_4' };
      return {
        info: { id: 'msg_assistant' },
        parts: [
          { id: 'prt_user', messageID: 'msg_user', type: 'text', text: 'Add a cache layer' },
          { id: 'prt_reply', messageID: 'msg_assistant', type: 'text', text: 'Which store should it use?' },
        ],
      };
    });

    const turn = await svc.startConversation(request({ runners: ['opencode'] }));
    expect(turn.text).toBe('Which store should it use?');
    expect(turn.text).not.toContain('Add a cache layer');
  });

  it('surfaces a server-side failure as a visible chat error', async () => {
    const { svc } = openCodeService((url) => {
      if (url.endsWith('/session')) return { id: 'ses_opencode_3' };
      // AssistantMessage.error is a tagged union, not a bare `{message}`.
      return { info: { error: { name: 'ProviderAuthError', data: { message: 'rate limited' } } }, parts: [] };
    });

    const turn = await svc.startConversation(request({ runners: ['opencode'] }));
    expect(turn.kind).toBe('message');
    expect(turn.text).toContain('rate limited');
  });

  it('addresses the model as {providerID, modelID}, which is what the API takes', async () => {
    const seen: unknown[] = [];
    const spawned = fakeSpawn([]);
    const originalSpawn = spawned.spawn;
    const spawn: typeof originalSpawn = (cmd, argv, opts) => {
      const proc = originalSpawn(cmd, argv, opts);
      queueMicrotask(() => spawned.processes[spawned.processes.length - 1].emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
      return proc;
    };
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/event')) return { ok: true, status: 200, statusText: 'OK', body: null } as unknown as Response;
      if (url.endsWith('/mcp')) return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ordewell: { status: 'connected' } }) } as unknown as Response;
      if (init?.body) seen.push(JSON.parse(String(init.body)));
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => (url.endsWith('/session') ? { id: 'ses_1' } : { parts: [{ id: 'p1', type: 'text', text: 'ok' }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const svc = new CliAgentAiService(
      fakeConfig({ aiProvider: 'opencode', orchestratorModel: 'anthropic/claude-sonnet-4' }),
      { spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', workspaceRoot: () => '/repo', isDirectory: () => true, exists: () => true, mcpServer: fakeMcpServer() },
    );
    await svc.startConversation(request({ runners: ['opencode'] }));

    const message = seen.find((b) => (b as { parts?: unknown }).parts) as { model?: unknown };
    expect(message.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('withholds the tools that would block the turn on a user who is not watching', async () => {
    const seen: { url: string; body?: Record<string, unknown> }[] = [];
    const { svc } = openCodeService((url, init) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/session')) return { id: 'ses_tools' };
      return { info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] };
    });
    await svc.startConversation(request({ runners: ['opencode'] }));

    const tools = seen.find((s) => s.url.includes('/message'))!.body!.tools as Record<string, boolean>;
    // `question` blocks the message POST until an answer arrives, which for a
    // planner is never; the rest are the write tools.
    expect(tools.question).toBe(false);
    expect(tools.write).toBe(false);
    expect(tools.edit).toBe(false);
    expect(tools.apply_patch).toBe(false);
  });

  it('rejects a permission the server raises, which is the only thing that unblocks the turn', async () => {
    const posted: string[] = [];
    const ask = {
      type: 'permission.asked',
      properties: {
        id: 'per_1',
        sessionID: 'ses_perm',
        permission: 'external_directory',
        patterns: ['/etc/*'],
        metadata: { filepath: '/etc/hostname' },
      },
    };
    // The real server settles the message POST only once the permission is
    // answered, so the fake blocks on it too — an unanswered request is the
    // hang this test exists to prevent.
    let answered: () => void;
    const permissionAnswered = new Promise<void>((resolve) => { answered = resolve; });
    const { svc } = openCodeService(
      (url) => {
        posted.push(url);
        if (url.endsWith('/session')) return { id: 'ses_perm' };
        if (url.includes('/permission/')) { answered(); return true; }
        return permissionAnswered.then(() => ({
          info: { id: 'msg_a' },
          parts: [
            { id: 'p1', messageID: 'msg_a', type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'error', input: { filePath: '/etc/hostname' }, error: 'The user rejected permission to use this specific tool call.' } },
            { id: 'p2', messageID: 'msg_a', type: 'text', text: 'I cannot read outside the workspace.' },
          ],
        }));
      },
      [`data: ${JSON.stringify(ask)}\n`],
    );

    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['opencode'] }));

    expect(posted).toContain('http://127.0.0.1:44100/permission/per_1/reply');
    const denied = events.find((e) => e.type === 'tool_result' && e.step?.outcome === 'denied');
    expect(denied?.step?.toolLabel).toBe('external_directory');
    expect(turn.text).toContain('cannot read outside the workspace');
  });

  it('rejects a permission a subagent’s child session raises', async () => {
    const posted: string[] = [];
    const child = { type: 'session.created', properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_parent' } } };
    const ask = { type: 'permission.asked', properties: { id: 'per_child', sessionID: 'ses_child', permission: 'bash', patterns: ['rm -rf *'] } };
    const { svc } = openCodeService(
      (url) => {
        posted.push(url);
        if (url.endsWith('/session')) return { id: 'ses_parent' };
        return new Promise((resolve) => setTimeout(() => resolve({ info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] }), 0));
      },
      [`data: ${JSON.stringify(child)}\n`, `data: ${JSON.stringify(ask)}\n`],
    );
    await svc.startConversation(request({ runners: ['opencode'] }));

    expect(posted).toContain('http://127.0.0.1:44100/permission/per_child/reply');
  });

  it('ignores a permission raised for a different session', async () => {
    const posted: string[] = [];
    const ask = {
      type: 'permission.asked',
      properties: { id: 'per_other', sessionID: 'ses_someone_else', permission: 'bash', patterns: ['*'] },
    };
    const { svc } = openCodeService(
      (url) => {
        posted.push(url);
        if (url.endsWith('/session')) return { id: 'ses_mine' };
        return { info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] };
      },
      [`data: ${JSON.stringify(ask)}\n`],
    );
    await svc.startConversation(request({ runners: ['opencode'] }));

    expect(posted.some((u) => u.includes('/permission'))).toBe(false);
  });

  it('reuses the agent session across a restart when the server still has it', async () => {
    const controller = new AbortController();
    const posted: string[] = [];
    let firstTurn = true;
    const { svc } = openCodeService((url, init) => {
      if (init?.method === 'POST') posted.push(new URL(url).pathname);
      if (url.endsWith('/session') && init?.method === 'POST') return { id: 'ses_kept' };
      if (url.endsWith('/session/ses_kept')) return { id: 'ses_kept' };
      if (firstTurn) { firstTurn = false; controller.abort(); return {}; }
      return { info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] };
    });

    await svc.startConversation(request({ runners: ['opencode'], signal: controller.signal }));
    const turn = await svc.continueConversation('Carry on', () => {});

    expect(posted.filter((p) => p === '/session')).toHaveLength(1);
    expect(posted).toContain('/session/ses_kept/message');
    expect(turn.text).toBe('ok');
  });

  it('starts a fresh session when the resumed one is gone', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    let firstTurn = true;
    const { svc } = openCodeService((url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/session') && init?.method === 'POST') return { id: 'ses_first' };
      if (url.endsWith('/session/ses_first')) return null;
      if (firstTurn) { firstTurn = false; controller.abort(); return {}; }
      return { info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] };
    });

    await svc.startConversation(request({ runners: ['opencode'], signal: controller.signal }));
    const turn = await svc.continueConversation('Carry on', () => {});

    // The stale id is probed, found missing, and replaced rather than used.
    expect(seen).toContain('GET /session/ses_first');
    expect(seen.filter((s) => s === 'POST /session')).toHaveLength(2);
    expect(turn.text).toBe('ok');
  });

  /**
   * Replays of turns recorded from `opencode serve`. The settled response is
   * held back a macrotask, so every recorded frame reaches the adapter first —
   * the order the live server produced them in.
   */
  function replayOpenCode(name: string) {
    const { sessionId, frames, response } = openCodeFixture(name);
    return openCodeService((url) => {
      if (url.endsWith('/session')) return { id: sessionId };
      return new Promise((resolve) => setTimeout(() => resolve(response), 0));
    }, frames);
  }

  it('streams the recorded reply token by token and keeps it once in the turn text', async () => {
    const { svc } = replayOpenCode('prose');

    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['opencode'] }));

    const final = 'math.ts exports a single `add` function (`(a, b) => a + b`).';
    expect(turn.text).toBe(final);
    expect(events.flatMap((e) => (e.type === 'text_delta' && e.text ? [e.text] : [])).join('')).toBe(final);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(3);
  });

  it('closes a recorded subagent with its own usage and keeps its report out of the reply', async () => {
    const { svc } = replayOpenCode('subagent');

    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, runners: ['opencode'] }));

    expect(turn.text).toBe('`math.ts` exports a single function `add(a: number, b: number): number`.');
    const finished = events.find((e) => e.type === 'subagent_finished');
    // The child session's own totals as the server reported them when the
    // recording was made: input 5244 + cache reads 9472, output 314.
    expect(finished?.usage).toMatchObject({ inputTokens: 14716, outputTokens: 314 });

    // Restated at every status change on the wire; reported once.
    expect(events.filter((e) => e.type === 'subagent_started' || e.type === 'subagent_finished').map((e) => e.type)).toEqual(['subagent_started', 'subagent_finished']);
  });

  it('connects the event stream before sending, so an early permission is not missed', async () => {
    const order: string[] = [];
    const { svc } = openCodeService((url) => {
      order.push(url.endsWith('/event') ? 'event' : url.endsWith('/session') ? 'session' : 'message');
      if (url.endsWith('/session')) return { id: 'ses_order' };
      return { info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] };
    }, []);
    await svc.startConversation(request({ runners: ['opencode'] }));

    expect(order.indexOf('event')).toBeLessThan(order.indexOf('message'));
  });
});

/**
 * The non-conversational entry points — `ordewell plan --goal`, the web REST
 * plan route, plan modification — all funnel through one short-lived agent
 * session. These run the whole pipeline for each agent with no network and no
 * credentials, which is what makes them CI's coverage of this backend.
 */
describe('CliAgentAiService — one-shot plan generation', () => {
  it('generates a validated plan through a Claude Code session that does not outlive it', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'plan', { PLAN: planJson() })]);
    const result = await svc.researchAndPlan(
      'Add the thing',
      ['claude-code'],
      { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
      fakeFileSystem(),
      () => {},
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].assignedRunner).toBe('claude-code');
    expect(result.researchLog[0]).toMatchObject({ type: 'user_prompt', content: 'Add the thing' });
    expect(spawned.processes[0].killed).toBe(true);
    expect(svc.hasActiveConversation()).toBe(false);
  });

  // The plan display a vendor planner's one-shot feeds token by token. The
  // agent's narration around the envelope is prose, which a one-shot does not
  // stream.
  it('streams the plan envelope to the plan display, and nothing of the narration', async () => {
    const plan = planJson();
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      createAdapter: scriptedAdapter([[
        { type: 'assistant_text', text: 'Here is the plan.' },
        { type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'README.md' } },
        { type: 'tool_result', id: 'c1', name: 'Read', output: '# App', success: true },
        { type: 'assistant_text_delta', text: plan.slice(0, 40) },
        { type: 'assistant_text_delta', text: plan.slice(40) },
        { type: 'assistant_text', text: plan },
        { type: 'turn_end' },
      ]]),
      workspaceRoot: () => '/repo',
    });
    const tokens: string[] = [];

    const tasks = await svc.generatePlanDirect('Add the thing', ['claude-code'], {}, (token) => tokens.push(token));

    expect(tasks).toHaveLength(1);
    expect(tokens.join('')).toBe(plan);
  });

  it('generates a validated plan through a Codex session', async () => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'plan', { PLAN: planJson('codex') })]);
    const tasks = await svc.sendPlanningPrompt('Plan the thing', ['codex']);

    expect(tasks).toHaveLength(1);
    expect(spawned.processes[0].killed).toBe(true);
  });

  it('surfaces a one-shot agent failure instead of returning an empty plan', async () => {
    const { svc } = service('claude-code', [
      (_written, proc) => {
        proc.emitStderr('Invalid API key · Please run /login');
        proc.exit(1);
      },
    ]);

    await expect(svc.sendPlanningPrompt('Plan the thing', ['claude-code'])).rejects.toThrow(/login|exited/i);
  });

  it('keeps a one-shot from becoming the open chat\'s resume hint', async () => {
    // A one-shot runs its own agent session. Letting its id become the resume
    // hint would restart the chat into a plan-generation session that never
    // shared its goal.
    const controller = new AbortController();
    const { svc, spawned } = service('claude-code', [
      (_written, proc) => {
        proc.emitStdout('{"type":"system","subtype":"init","session_id":"sess-chat"}\n');
        controller.abort();
      },
      '{"type":"system","subtype":"init","session_id":"sess-oneshot"}\n' + fixture('claude-code', 'plan', { PLAN: planJson() }),
      fixture('claude-code', 'prose'),
    ]);
    await svc.startConversation(request({ signal: controller.signal }));
    await svc.sendPlanningPrompt('Plan the thing', ['claude-code']);
    await svc.continueConversation('Carry on', () => {});

    const args = spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-chat');
  });
});

/**
 * The `stream-*` fixtures are recorded from Claude Code 2.1.283 with the
 * adapter's own flags, then scrubbed of session ids and paths. Their numbers
 * are the CLI's, which is why the expectations below are literals.
 */
describe('CliAgentAiService — Claude Code partial messages, usage and subagents', () => {
  const plannerTokens = (events: ResearchProgress[]) => events.filter((e) => e.type === 'text_delta').map((e) => e.text);
  const usageRecords = (events: ResearchProgress[]) => events.flatMap((e) => (e.type === 'usage' && e.record ? [e.record] : []));

  it('streams reply deltas that add up to the final text, paragraph break included', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'stream-tool-rounds')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    expect(plannerTokens(events)).toEqual([
      'I\'ll read README.md now', '.', '\n\n', 'The first line of README.md is', ' "hello".',
    ]);
    expect(turn.text).toBe('I\'ll read README.md now.\n\nThe first line of README.md is "hello".');
  });

  // Claude Code in print mode redacts thinking: the blocks and their deltas
  // arrive with empty text. An empty thinking row is noise, not reasoning.
  it('shows nothing for redacted thinking and still streams the reply', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'stream-reasoning')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    expect(events.filter((e) => e.type === 'thinking')).toEqual([]);
    expect(plannerTokens(events).join('')).toBe('No, 391 is not prime, because 17 × 23 = 391.');
    expect(turn.text).toBe('No, 391 is not prime, because 17 × 23 = 391.');
  });

  // Anthropic's `input_tokens` excludes both cache reads and cache writes, so
  // the prompt the model saw is the sum of all three; the read share is the
  // cached one.
  it('reports each planner call\'s usage once, and the turn\'s cost with the context window', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'stream-tool-rounds')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    expect(usageRecords(events)).toEqual([
      { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 18604, cachedInputTokens: 9428, outputTokens: 162 },
      { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 20025, cachedInputTokens: 18602, outputTokens: 14 },
      { source: 'claude-code', reportedCost: { amount: 0.049754, currency: 'USD' }, contextWindow: 1000000 },
    ]);
    const usage = usageRecords(events).reduce(addPlannerUsage, { totals: {} });
    expect(usage.totals).toEqual({
      inputTokens: 38629, cachedInputTokens: 28030, outputTokens: 176, reportedCost: { USD: 0.049754 },
    });
    expect(plannerContextFill(usage)).toEqual({ usedTokens: 20025, windowTokens: 1000000 });
  });

  // A prompt of 0 would read as an empty context; absent is "not reported" (ADR-0017 U1).
  it('leaves the prompt out of a call that reported only its output, rather than counting it as zero', async () => {
    const lines = [
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-sonnet-5' } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] } },
      { type: 'result', subtype: 'success' },
    ];
    const { svc } = service('claude-code', [lines.map((l) => `${JSON.stringify(l)}\n`).join('')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    expect(usageRecords(events)).toEqual([{ source: 'claude-code', model: 'claude-sonnet-5', outputTokens: 7 }]);
  });

  // `total_cost_usd` is the session's running total: 0.075482 after the first
  // of these recorded turns, 0.0866244 after the second.
  it('reports each turn\'s own share of the session cost', async () => {
    const { svc } = service('claude-code', [
      fixture('claude-code', 'stream-reasoning'),
      fixture('claude-code', 'stream-reasoning-followup'),
    ]);
    const first = collector();
    await svc.startConversation(request({ onProgress: first.onProgress }));
    const second = collector();
    await svc.continueConversation('And 397?', second.onProgress);

    const costs = (events: ResearchProgress[]) => usageRecords(events).flatMap((r) => (r.reportedCost ? [r.reportedCost.amount] : []));
    expect(costs(first.events)).toHaveLength(1);
    expect(costs(first.events)[0]).toBeCloseTo(0.075482, 10);
    expect(costs(second.events)).toHaveLength(1);
    expect(costs(second.events)[0]).toBeCloseTo(0.0111424, 10);
  });

  // A resumed session restores its running total (recorded: 0.0943048 on the
  // first turn after `--resume`, most of it spent before). Reporting it would
  // count those turns again.
  it('reports no cost for the first turn after a resume, rather than the whole session\'s', async () => {
    const controller = new AbortController();
    const { svc, spawned } = service('claude-code', [
      (_written, proc) => {
        proc.emitStdout('{"type":"system","subtype":"init","session_id":"sess-claude-stream-1"}\n');
        controller.abort();
      },
      fixture('claude-code', 'stream-resumed'),
    ]);
    await svc.startConversation(request({ signal: controller.signal }));
    const { events, onProgress } = collector();
    const turn = await svc.continueConversation('Reply with just: ok', onProgress);

    expect(spawned.lastArgs()).toContain('--resume');
    expect(turn.text).toBe('ok');
    expect(usageRecords(events).some((r) => r.reportedCost)).toBe(false);
    expect(usageRecords(events).filter((r) => r.outputTokens !== undefined)).toHaveLength(1);
  });

  describe('a foreground subagent', () => {
    const AGENT = 'toolu_01UCfgesRK1YbX7JNVCSJXJM';
    const run = async () => {
      const { svc } = service('claude-code', [fixture('claude-code', 'stream-subagent')]);
      const { events, onProgress } = collector();
      const turn = await svc.startConversation(request({ onProgress }));
      return { events, turn };
    };

    it('nests the subagent\'s steps under the Agent call that started it', async () => {
      const { events, turn } = await run();

      const lifecycle = events.filter((e) => ['subagent_started', 'tool_call', 'tool_result', 'subagent_finished'].includes(e.type));
      expect(lifecycle.map((e) => [e.type, e.toolCallId ?? null, e.subagentId ?? null])).toEqual([
        ['tool_call', AGENT, null],
        ['subagent_started', null, AGENT],
        ['tool_call', 'toolu_016AyPnsMaJefcgUptD2hr6L', AGENT],
        ['tool_result', 'toolu_016AyPnsMaJefcgUptD2hr6L', AGENT],
        ['subagent_finished', null, AGENT],
        ['tool_result', AGENT, null],
      ]);
      expect(events.find((e) => e.type === 'subagent_started')?.brief).toBe('Read README first line');
      const finished = events.find((e) => e.type === 'subagent_finished');
      expect(finished?.outcome).toBe('done');
      expect(finished?.digest).toContain('The first line of README.md is exactly:');
      expect(turn.researchLog.flatMap((s) => ('toolCallId' in s && s.subagentId ? [s.toolCallId] : []))).toEqual(['toolu_016AyPnsMaJefcgUptD2hr6L']);
      expect(turn.text).toBe('The first line of README.md is `hello`.');
    });

    // The subagent's calls do not stream, and their lines carry the usage
    // snapshot from before generation: its prompt, with a placeholder for
    // output. Its last call is reported whole on the Agent tool's result.
    it('counts the subagent\'s calls toward it, and the session cost once', async () => {
      const { events } = await run();

      expect(usageRecords(events).filter((r) => r.subagentId)).toEqual([
        { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 12418, cachedInputTokens: 0, subagentId: AGENT },
        { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 13952, cachedInputTokens: 12416, outputTokens: 380, subagentId: AGENT },
      ]);
      expect(events.find((e) => e.type === 'subagent_finished')?.usage).toEqual({ inputTokens: 26370, cachedInputTokens: 12416, outputTokens: 380 });
      const usage = usageRecords(events).reduce(addPlannerUsage, { totals: {} });
      expect(usage.totals.outputTokens).toBe(254 + 209 + 380);
      expect(usage.totals.reportedCost?.USD).toBeCloseTo(0.0973464, 10);
    });
  });

  // Recorded with stdin held open, as the planner holds it: the launch turn
  // ends, then the subagent works, and its end is announced by a
  // `task_notification` rather than by the `Agent` result, which returned at
  // launch. Claude Code then opens a turn of its own to relay the report; the
  // second fixture plays that stretch into the turn asking the planner to wait.
  describe('a backgrounded subagent', () => {
    const AGENT = 'toolu_01V8422dTKLiNaXutJaP8wKr';
    const run = async () => {
      const { svc, spawned } = service('claude-code', [
        fixture('claude-code', 'stream-async-agent'),
        fixture('claude-code', 'stream-async-agent-report'),
      ]);
      const { events, onProgress } = collector();
      const turn = await svc.startConversation(request({ onProgress }));
      return { events, turn, spawned };
    };

    it('stays open past its launch and finishes on the completion notice', async () => {
      const { events, turn, spawned } = await run();

      expect(writes(spawned.processes[0])).toHaveLength(2);
      const lifecycle = events.filter((e) => ['subagent_started', 'tool_call', 'tool_result', 'subagent_finished'].includes(e.type));
      expect(lifecycle.map((e) => [e.type, e.toolCallId ?? null, e.subagentId ?? null])).toEqual([
        ['tool_call', AGENT, null],
        ['subagent_started', null, AGENT],
        ['tool_result', AGENT, null],
        ['tool_call', 'toolu_014VcqikXMDUQjnnVumKeHQv', AGENT],
        ['tool_result', 'toolu_014VcqikXMDUQjnnVumKeHQv', AGENT],
        ['subagent_finished', null, AGENT],
      ]);
      const finished = events.find((e) => e.type === 'subagent_finished');
      expect(finished?.outcome).toBe('done');
      expect(finished?.digest).toBe('The first line of README.md is:\n\n`hello`');
      expect(turn.text).toContain('Launched the Explore agent in the background');
      expect(turn.text).toContain('The first line of README.md is `hello`.');
      expect(turn.text).not.toContain('is:\n\n`hello`');
    });

    it('counts each subagent message once, however many lines it spans', async () => {
      const { events } = await run();

      expect(usageRecords(events).filter((r) => r.subagentId)).toEqual([
        { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 11163, cachedInputTokens: 4271, subagentId: AGENT },
        { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 12698, cachedInputTokens: 11161, subagentId: AGENT },
      ]);
      const usage = usageRecords(events).reduce(addPlannerUsage, { totals: {} });
      expect(usage.totals.reportedCost?.USD).toBeCloseTo(0.0913891, 10);
    });
  });
});

describe('CliAgentAiService — resource lifecycle', () => {
  it('kills the agent process after a committed plan closed the conversation', async () => {
    // The leak this guards: a committed plan nulls the conversation while the
    // adapter still holds a live agent process, so a host that gated `reset()`
    // on `hasActiveConversation()` disposed nothing.
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'plan', { PLAN: planJson() })]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('plan');
    expect(svc.hasActiveConversation()).toBe(false);
    expect(spawned.processes[0].killed).toBe(false);

    svc.reset();
    expect(spawned.processes[0].killed).toBe(true);
  });

  it('is idempotent, so callers never have to gate it', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    svc.reset();
    expect(() => { svc.reset(); svc.reset(); }).not.toThrow();
    expect(spawned.processes[0].killed).toBe(true);
  });
});

describe('CliAgentAiService — conversationMatchesConfig', () => {
  // The model is a spawn-time CLI argument (--model), not a per-turn field —
  // a picker change mid-conversation cannot reach the already-running
  // process, so Session needs a way to know the live conversation is stale.
  it('is true with no conversation started yet', () => {
    const { svc } = service('claude-code', []);
    expect(svc.conversationMatchesConfig()).toBe(true);
  });

  it('is true right after starting, and stays true while config is unchanged', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'prose')], { orchestratorModel: 'sonnet' });
    await svc.startConversation(request());
    expect(svc.conversationMatchesConfig()).toBe(true);
  });

  it('goes false when the configured model changes after the conversation started', async () => {
    const { svc, config } = service('claude-code', [fixture('claude-code', 'prose')], { orchestratorModel: 'sonnet' });
    await svc.startConversation(request());

    (config as { orchestratorModel: string }).orchestratorModel = 'haiku';

    expect(svc.conversationMatchesConfig()).toBe(false);
  });

  it('goes false when the configured effort changes after the conversation started', async () => {
    const { svc, config } = service('claude-code', [fixture('claude-code', 'prose')], {
      orchestratorModel: 'opus', plannerThinkingEffort: 'low',
    });
    await svc.startConversation(request());

    (config as { plannerThinkingEffort: string }).plannerThinkingEffort = 'high';

    expect(svc.conversationMatchesConfig()).toBe(false);
  });

  it('goes true again once the stale conversation is torn down and restarted', async () => {
    const { svc, config } = service('claude-code', [
      fixture('claude-code', 'prose'),
      fixture('claude-code', 'prose'),
    ], { orchestratorModel: 'sonnet' });
    await svc.startConversation(request());

    (config as { orchestratorModel: string }).orchestratorModel = 'haiku';
    expect(svc.conversationMatchesConfig()).toBe(false);

    await svc.startConversation(request());
    expect(svc.conversationMatchesConfig()).toBe(true);
  });
});

describe('createAiService', () => {
  it('routes a harness planner to the CLI agent service', () => {
    expect(createAiService(fakeConfig({ aiProvider: 'claude-code' }))).toBeInstanceOf(CliAgentAiService);
    expect(createAiService(fakeConfig({ aiProvider: 'opencode' }))).toBeInstanceOf(CliAgentAiService);
  });

  it('leaves vendor providers on their HTTP transports', () => {
    expect(createAiService(fakeConfig({ aiProvider: 'openrouter' }))).not.toBeInstanceOf(CliAgentAiService);
    expect(createAiService(fakeConfig({ aiProvider: 'google' }))).not.toBeInstanceOf(CliAgentAiService);
  });
});
