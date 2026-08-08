import { describe, it, expect } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { createAiService } from '../AiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { IConfig } from '../../interfaces/IConfig';
import type { ConversationRequest } from '../AiService';
import type { ResearchProgress } from '../../models/Task';
import { fakeSpawn, fixture, planJson, type FakeSpawnOptions, type ScriptedReply } from './harnessTestKit';

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
    ...overrides,
  };
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

  it('repairs a botched plan with a bounded corrective re-emit', async () => {
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'broken-plan'),
      fixture('claude-code', 'plan', { PLAN: planJson() }),
    ]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('plan');
    // Two user messages went in: the goal, then the corrective re-emit.
    const sent = spawned.processes[0].written;
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('Re-emit the COMPLETE corrected plan');
  });

  it('degrades to prose when the repair budget is exhausted', async () => {
    const broken = fixture('claude-code', 'broken-plan');
    const { svc, spawned } = service('claude-code', [broken, broken, broken]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    // One goal + two corrective re-emits, then it stops asking.
    expect(spawned.processes[0].written).toHaveLength(3);
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
    expect(spawned.processes[0].written).toHaveLength(2);
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

    const opening = spawned.processes[0].written[0];
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
    expect(threadStart.params.config).toEqual({ features: { use_legacy_landlock: true } });
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
      fixture('codex', 'new-conversation'),
      fixture('codex', 'tools'),
    ]);
    await svc.startConversation(request({ runners: ['codex'], signal: controller.signal }));
    const turn = await svc.continueConversation('Carry on', () => {});

    const methods = spawned.processes[1].written.map((line) => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'thread/resume', 'thread/start', 'turn/start']);
    expect(turn.kind).toBe('message');
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
      const body = routes(url, init);
      if (url.endsWith('/event')) {
        if (!sseFrames) return { ok: true, status: 200, statusText: 'OK', body: null } as unknown as Response;
        const pending = [...sseFrames];
        const signal = init?.signal;
        const reader = {
          read: () => (pending.length
            ? Promise.resolve({ done: false, value: new TextEncoder().encode(pending.shift()!) })
            // Idle until the turn ends and aborts the stream, as a live server is.
            : new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              if (signal?.aborted) return resolve({ done: true });
              signal?.addEventListener('abort', () => resolve({ done: true }), { once: true });
            })),
        };
        return { ok: true, status: 200, statusText: 'OK', body: { getReader: () => reader } } as unknown as Response;
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
      { spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', workspaceRoot: () => '/repo', isDirectory: () => true, exists: () => true },
    );
    return { svc, spawned };
  }

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
      if (init?.body) seen.push(JSON.parse(String(init.body)));
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => (url.endsWith('/session') ? { id: 'ses_1' } : { parts: [{ id: 'p1', type: 'text', text: 'ok' }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const svc = new CliAgentAiService(
      fakeConfig({ aiProvider: 'opencode', orchestratorModel: 'anthropic/claude-sonnet-4' }),
      { spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', workspaceRoot: () => '/repo', isDirectory: () => true, exists: () => true },
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
        if (url.includes('/permissions/')) { answered(); return true; }
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

    expect(posted).toContain('http://127.0.0.1:44100/session/ses_perm/permissions/per_1');
    const denied = events.find((e) => e.type === 'tool_result' && e.step?.outcome === 'denied');
    expect(denied?.step?.toolLabel).toBe('external_directory');
    expect(turn.text).toContain('cannot read outside the workspace');
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

    expect(posted.some((u) => u.includes('/permissions/'))).toBe(false);
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
