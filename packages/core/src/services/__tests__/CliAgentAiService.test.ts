import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { createAiService } from '../AiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { IConfig } from '../../interfaces/IConfig';
import type { ConversationRequest } from '../AiService';
import { TurnBudgets } from '../PlannerBudgets';
import type { ResearchProgress, ResearchStep } from '../../models/Task';
import { fakeMcpServer, fakeSpawn, fixture, openCodeFixture, planJson, scriptedAdapter, sseResponse, type FakeAgentProcess, type FakeMcpServer, type FakeSpawnOptions, type ScriptedReply } from './harnessTestKit';
import type { McpToolReply, SubmitPlanArgs } from '../mcp/tools';
import type { SkillLookup } from '../taskSkills';
import type { SkillInfo } from '../SkillsService';
import type { AgentAdapter, AgentEvent, PlannerStartOptions } from '../harness/AgentAdapter';
import type { ApprovalRequest } from '../../interfaces/IApproval';
import { addPlannerUsage, plannerContextFill } from '../../models/Usage';
import { TurnStream } from '../replyStream';
import { WebReadPolicy, type WebRead } from '../webReadPolicy';
import { summarizeToolCall } from '../researchStepSummary';
import { recordedRunnerAuth, resetRunnerAuth } from '../runnerAuth';

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
  mcp: FakeMcpServer = fakeMcpServer(),
  turnBudgets?: TurnBudgets,
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
      mcpServer: mcp,
      turnBudgets,
    },
  );
  return { svc, spawned, config };
}

/**
 * A one-shot agent turn that calls submit_plan with `tasks` through the
 * handler the service issued its token with, then ends on `reply`. Each
 * call's answer goes to `answers`.
 */
function submitting(mcp: FakeMcpServer, tasks: unknown, reply: string, answers: McpToolReply[] = []): ScriptedReply {
  return (_written, proc) => {
    void mcp.plannerHandlers.at(-1)!.submitPlan!({ tasks: tasks as SubmitPlanArgs['tasks'] }, { signal: new AbortController().signal })
      .then((answer) => {
        answers.push(answer);
        proc.emitStdout(reply);
      });
  };
}

const planTasks = (runner = 'claude-code'): unknown => (JSON.parse(planJson(runner)) as { tasks: unknown }).tasks;
/** A Claude Code turn whose whole reply is `text`. */
function claudeSays(text: string): string {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-says', cwd: '/repo', permissionMode: 'plan' },
    { type: 'assistant', session_id: 'sess-says', message: { id: 'msg_says', role: 'assistant', content: text ? [{ type: 'text', text }] : [] } },
    { type: 'result', subtype: 'success', session_id: 'sess-says', is_error: false, result: text },
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

/** The same turn with the `claude_code_version` a real `init` carries, for the native-shell check (ADR-0036 N2). */
function claudeVersionSays(version: string, text: string): string {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-version', cwd: '/repo', permissionMode: 'plan', claude_code_version: version },
    { type: 'assistant', session_id: 'sess-version', message: { id: 'msg_version', role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-version', is_error: false, result: text },
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

/**
 * A Claude Code turn cut short by its usage limit: the CLI says the limit once
 * as an assistant message and again as the `result` of an `is_error` turn.
 */
function claudeHitsLimit(said: string, result: string, before = ''): string {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-limit', cwd: '/repo', permissionMode: 'plan' },
    ...(before ? [{ type: 'assistant', session_id: 'sess-limit', message: { id: 'msg_before', role: 'assistant', content: [{ type: 'text', text: before }] } }] : []),
    { type: 'assistant', session_id: 'sess-limit', message: { id: 'msg_limit', role: 'assistant', content: [{ type: 'text', text: said }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-limit', is_error: true, result },
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

/** The reply text a surface is still showing once the turn's retractions are applied. */
function shownReply(events: ResearchProgress[]): string {
  const segments = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'text_delta' && event.segmentId) segments.set(event.segmentId, (segments.get(event.segmentId) ?? '') + (event.text ?? ''));
    else if (event.type === 'text_retracted') {
      if (event.segmentId) segments.delete(event.segmentId);
      else segments.clear();
    }
  }
  return [...segments.values()].join('');
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
  return proc.written.filter((line) => !line.includes('"subtype":"mcp_status"') && !line.includes('"subtype":"initialize"'));
}

function collector() {
  const events: ResearchProgress[] = [];
  return { events, onProgress: (p: ResearchProgress) => events.push(p) };
}

/**
 * A Claude Code turn that calls `tool`, waits on the control channel as the
 * CLI does, and returns the answer as the tool's result before replying
 * `reply`. `turns` repeats it for the corrective turns an empty reply draws.
 */
function reachingFor(tool: string, input: Record<string, unknown>, server?: string, reply = 'Done.', turns = 1): ScriptedReply[] {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const onUserTurn: ScriptedReply = (written, proc) => {
    if (!written.includes('"type":"user"')) return;
    proc.emitStdout([
      line({ type: 'system', subtype: 'init', session_id: 'sess-reach', cwd: '/repo', permissionMode: 'default' }),
      line({ type: 'assistant', session_id: 'sess-reach', message: { id: 'msg_reach', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_reach', name: tool, input }] } }),
      line({
        type: 'control_request', request_id: 'req_reach',
        request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: 'toolu_reach', ...(server ? { mcp_server: { name: server } } : {}) },
      }),
    ].join(''));
  };
  const onAnswer: ScriptedReply = (written, proc) => {
    if (!written.includes('"type":"control_response"')) return onUserTurn(written, proc);
    const answer = (JSON.parse(written) as { response: { response: { behavior: string; message?: string } } }).response.response;
    const denied = answer.behavior === 'deny';
    proc.emitStdout([
      line({ type: 'user', session_id: 'sess-reach', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_reach', content: denied ? answer.message : 'ok', is_error: denied }] } }),
      line({ type: 'assistant', session_id: 'sess-reach', message: { id: 'msg_reply', role: 'assistant', content: reply ? [{ type: 'text', text: reply }] : [] } }),
      line({ type: 'result', subtype: 'success', session_id: 'sess-reach', is_error: false, result: reply }),
    ].join(''));
  };
  return Array.from({ length: turns * 2 }, () => onAnswer);
}

/** The behavior the service answered the scripted request with. */
function controlAnswer(proc: FakeAgentProcess): Record<string, unknown> | undefined {
  const line = proc.written.find((w) => w.includes('"type":"control_response"') && w.includes('req_reach'));
  return line ? (JSON.parse(line) as { response: { response: Record<string, unknown> } }).response.response : undefined;
}

function approvalSpy(grant: boolean) {
  return { request: vi.fn(async (_req: ApprovalRequest) => grant) };
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

  it('spawns read-only: write and shell tools disallowed, what the mode leaves open routed to Ordewell', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    const args = spawned.lastArgs();
    expect(spawned.lastCommand()).toBe('claude');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    const disallowed = args[args.indexOf('--disallowedTools') + 1];
    expect(disallowed).toContain('Write');
    expect(disallowed).toContain('Edit');
    expect(disallowed.split(',')).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode']));
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
      ['toolu_agent', undefined],
      ['toolu_sub_read', 'toolu_agent'],
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

  // It plans through Ordewell's tools alone (ADR-0025): a plan, an edit or a
  // read written in its reply is something it said, never something it did.
  it.each([
    ['a plan', planJson()],
    ['task edits', JSON.stringify({ taskOps: [{ op: 'update', taskId: '#1', changes: { title: 'x' } }] })],
    ['a read', JSON.stringify({ taskQuery: { tasks: ['#2'], catalog: true } })],
  ])('returns %s written in its reply as prose, and keeps the conversation open', async (_what, text) => {
    const { svc, spawned } = service('claude-code', [claudeSays(text)]);
    const turn = await svc.startConversation(request());

    expect(turn).toMatchObject({ kind: 'message', text });
    expect(svc.hasActiveConversation()).toBe(true);
    expect(writes(spawned.processes[0])).toHaveLength(1);
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

  it('carries the runs said before the wait ahead of the report\'s, each under the segment it streamed', async () => {
    const { svc } = service('claude-code', [
      fixture('claude-code', 'async-agent'),
      fixture('claude-code', 'async-agent-report'),
    ]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    const streamed = [...new Set(events.flatMap((e) => (e.type === 'text_delta' && e.segmentId ? [e.segmentId] : [])))];
    expect(turn.runs?.map((run) => run.segmentId)).toEqual(streamed);
    expect(turn.runs?.map((run) => run.text).join('\n\n')).toBe(turn.text);
    const before = turn.runs?.filter((run) => run.text.includes('explore the dashboard and the data layer')) ?? [];
    expect(before).toEqual([expect.objectContaining({ narration: true })]);
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

  it('never sends a botched plan in its reply back to be re-emitted', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'broken-plan'), fixture('claude-code', 'prose')]);
    const turn = await svc.startConversation(request());

    expect(turn.kind).toBe('message');
    expect(writes(spawned.processes[0])).toHaveLength(1);
  });

  it('nudges an empty reply toward submit_plan, not plan JSON', async () => {
    const { svc, spawned } = service('claude-code', [claudeSays(''), fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    const sent = writes(spawned.processes[0]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('submit the plan with submit_plan');
    expect(sent[1]).not.toContain('plan JSON');
  });

  it('denies a write the agent reaches for, in its own words, and records the call as denied', async () => {
    const { svc, spawned } = service('claude-code', reachingFor('Write', { file_path: '/repo/a.txt', content: 'a' }));
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress, approval: approvalSpy(true) }));

    const denied = events.find((e) => e.type === 'tool_result' && e.step?.outcome === 'denied');
    expect(denied?.step?.toolLabel).toBe('Write');
    expect(denied?.step?.result).toContain('read-only');
    // The refusal is answered on the control channel, or the agent stalls.
    expect(controlAnswer(spawned.processes[0])).toMatchObject({ behavior: 'deny' });
    expect(turn.kind).toBe('message');
  });

  it('asks before an MCP tool the user configured, scoped to that one tool, and lets it run once approved', async () => {
    const approval = approvalSpy(true);
    const { svc, spawned } = service('claude-code', reachingFor('mcp__claude_ai_Todoist__find-tasks', { filter: 'today' }, 'claude.ai Todoist'));
    await svc.startConversation(request({ approval }));

    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp_tool', scope: 'mcp__claude_ai_Todoist__find-tasks' }));
    expect(approval.request.mock.calls[0][0].subject).toContain('claude.ai Todoist');
    expect(controlAnswer(spawned.processes[0])).toEqual({ behavior: 'allow', updatedInput: { filter: 'today' } });
  });

  it('denies an MCP tool nobody can approve', async () => {
    const { svc, spawned } = service('claude-code', reachingFor('mcp__claude_ai_Todoist__find-tasks', {}));
    await svc.startConversation(request());

    expect(controlAnswer(spawned.processes[0])).toMatchObject({ behavior: 'deny' });
  });

  it('asks before a read outside the workspace, and not for one inside it', async () => {
    const outside = approvalSpy(false);
    const { svc: outsideSvc, spawned: outsideSpawn } = service('claude-code', reachingFor('Read', { file_path: '/etc/hosts' }));
    await outsideSvc.startConversation(request({ approval: outside }));
    // Judged where the path points (ADR-0028): on macOS /etc is a symlink to
    // /private/etc, on Linux it is not, so resolve the expectation the same way.
    expect(outside.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path', subject: realpathSync.native('/etc/hosts') }));
    expect(controlAnswer(outsideSpawn.processes[0])).toMatchObject({ behavior: 'deny' });

    const inside = approvalSpy(false);
    const { svc: insideSvc, spawned: insideSpawn } = service('claude-code', reachingFor('Read', { file_path: '/repo/src/a.ts' }));
    await insideSvc.startConversation(request({ approval: inside }));
    expect(inside.request).not.toHaveBeenCalled();
    expect(controlAnswer(insideSpawn.processes[0])).toMatchObject({ behavior: 'allow' });
  });

  it('decides a WebFetch through the web-read policy, and hands its reason back', async () => {
    const decide = vi.fn().mockResolvedValue({ allowed: false, reason: 'Fetch refused: the URL contains what looks like a secret.' });
    const fetcher = { decide, fetch: vi.fn() };
    const { svc, spawned } = service('claude-code', reachingFor('WebFetch', { url: 'https://docs.example.com/x', prompt: 'summarize' }));
    await svc.startConversation(request({ approval: approvalSpy(true), fetcher }));

    expect(decide).toHaveBeenCalledWith({ kind: 'fetch', url: 'https://docs.example.com/x' });
    expect(controlAnswer(spawned.processes[0])).toMatchObject({ behavior: 'deny', message: expect.stringContaining('looks like a secret') });
  });

  it('decides a WebSearch through the web-read policy as a search at Anthropic', async () => {
    const decide = vi.fn().mockResolvedValue({ allowed: false, reason: 'Web search refused: the query contains what looks like a secret.' });
    const fetcher = { decide, fetch: vi.fn() };
    const { svc, spawned } = service('claude-code', reachingFor('WebSearch', { query: 'tokio 1.40 changelog' }));
    await svc.startConversation(request({ approval: approvalSpy(true), fetcher }));

    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ kind: 'search', query: 'tokio 1.40 changelog', provider: 'anthropic' }));
    expect(controlAnswer(spawned.processes[0])).toMatchObject({ behavior: 'deny', message: expect.stringContaining('looks like a secret') });
  });

  it('asks once for a WebSearch, saying Anthropic already sees the conversation, and lets it run once approved', async () => {
    const approval = approvalSpy(true);
    const reads = new WebReadPolicy({ approval, env: () => ({}) });
    const fetcher = { decide: (read: WebRead) => reads.decide(read), fetch: vi.fn() };
    const { svc, spawned } = service('claude-code', reachingFor('WebSearch', { query: 'tokio 1.40 changelog' }));
    await svc.startConversation(request({ approval, fetcher }));

    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(approval.request.mock.calls[0][0]).toMatchObject({
      kind: 'web_search',
      subject: 'tokio 1.40 changelog',
      scope: 'web_search:anthropic',
      detail: expect.stringContaining('already sees this planner\'s conversation'),
    });
    expect(controlAnswer(spawned.processes[0])).toEqual({ behavior: 'allow', updatedInput: { query: 'tokio 1.40 changelog' } });
  });

  it('shows a WebSearch in the timeline under its own name, with the query visible', async () => {
    const { svc } = service('claude-code', reachingFor('WebSearch', { query: 'tokio 1.40 changelog' }));
    const { events, onProgress } = collector();
    const fetcher = { decide: vi.fn().mockResolvedValue({ allowed: true }), fetch: vi.fn() };
    await svc.startConversation(request({ onProgress, approval: approvalSpy(true), fetcher }));

    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ tool: 'web_search', toolLabel: 'WebSearch' });
    expect(summarizeToolCall(call!.tool!, call!.toolArgs!, call!.toolLabel)).toBe('web_search "tokio 1.40 changelog"');
  });

  it('shows a WebFetch in the timeline under its own name, with the URL visible', async () => {
    const { svc } = service('claude-code', reachingFor('WebFetch', { url: 'https://docs.example.com/x', prompt: 'summarize' }));
    const { events, onProgress } = collector();
    const fetcher = { decide: vi.fn().mockResolvedValue({ allowed: true }), fetch: vi.fn() };
    await svc.startConversation(request({ onProgress, approval: approvalSpy(true), fetcher }));

    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ tool: 'fetch', toolLabel: 'WebFetch' });
    expect(summarizeToolCall(call!.tool!, call!.toolArgs!, call!.toolLabel)).toBe('fetch https://docs.example.com/x');
  });

  it('denies a tool the envelope has no rule for without claiming it tried to change a file', async () => {
    const { svc, spawned } = service('claude-code', reachingFor('TodoWrite', { todos: [] }));
    await svc.startConversation(request({ approval: approvalSpy(true) }));

    const answer = controlAnswer(spawned.processes[0]);
    expect(answer).toMatchObject({ behavior: 'deny', message: expect.stringContaining('no rule for this tool') });
    expect(answer?.message).not.toContain('changes no files');
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

  it('fails a planner that exits while it starts in its own words, without a respawn on the same arguments', async () => {
    const { svc, spawned } = service('claude-code', [], {}, { exitOnSpawn: { code: 1, output: 'Invalid API key · Please run /login\n' } });

    const started = svc.startConversation(request());

    await expect(started).rejects.toThrow('Invalid API key · Please run /login');
    await expect(started).rejects.not.toThrow('Respawn');
    expect(spawned.processes).toHaveLength(1);
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

  it('appends the budget block to each message it sends the agent, and not to its system prompt', async () => {
    let reads = 3;
    const budgets = new TurnBudgets([() => `Task reads left for this message: ${reads}.`]);
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose'), fixture('claude-code', 'prose')], {}, {}, fakeMcpServer(), budgets);
    await svc.startConversation(request());
    reads = 2;
    await svc.continueConversation('Redis, please.', () => {});

    const sent = writes(spawned.processes[0]);
    expect(sent[0]).toContain('Add a cache layer\\n\\nCONTEXT AND BUDGETS (this turn):\\n- Task reads left for this message: 3.');
    expect(sent[1]).toContain('Redis, please.\\n\\nCONTEXT AND BUDGETS (this turn):\\n- Task reads left for this message: 2.');
    expect(spawned.lastArgs().join(' ')).not.toContain('CONTEXT AND BUDGETS');
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
        exited: false,
        start: async () => {},
        nativeSessionId: () => null,
        dispose: () => {},
        mcpAttached: async () => true,
        send: async (_message, onEvent, signal) => {
          signals.push(signal);
          if (signals.length === 2) await new Promise<void>((resolve) => { release = resolve; });
          onEvent({ type: 'assistant_text', runId: 'r1', text: 'ok' });
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

  it('restarts the planner on request from its own session, keeping the conversation (ADR-0029)', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose'), fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    svc.restart();
    expect(svc.hasActiveConversation()).toBe(true);
    await svc.continueConversation('Carry on', () => {});

    expect(spawned.processes).toHaveLength(2);
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-claude-1');
  });

  // 143 is 128 + SIGTERM: the CLI caught the signal and exited with the code.
  it('restarts a planner whose process ended between turns from its own session, rather than failing the next turn', async () => {
    const mcp = fakeMcpServer();
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose'), fixture('claude-code', 'prose')], {}, {}, mcp);
    await svc.startConversation(request());
    spawned.processes[0].exit(143);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const turn = await svc.continueConversation('Carry on', () => {});

    expect(turn).toMatchObject({ kind: 'message' });
    expect(turn).not.toHaveProperty('failed', true);
    expect(turn.text).toContain('in-process or Redis');
    expect(turn.text).not.toContain('143');
    expect(spawned.processes).toHaveLength(2);
    const args = spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-claude-1');
    expect(mcp.revoked).toEqual(['tok-1']);
  });

  it('restarts a planner that ended while idle even when a descendant still holds its pipes', async () => {
    // A crashed CLI's child (a shell, an MCP server) can inherit its stdout or
    // stderr and keep 'close' away; the process itself has still ended, so the
    // next message must restart it rather than write into its dead stdin.
    const answer = fixture('claude-code', 'prose');
    const { svc, spawned } = service('claude-code', [
      answer,
      (_written, proc) => { if (!proc.killed) proc.emitStdout(answer); },
    ]);
    await svc.startConversation(request());

    vi.useFakeTimers();
    try {
      spawned.processes[0].exitHoldingPipes(143);
      const turn = svc.continueConversation('Carry on', () => {});
      await vi.advanceTimersByTimeAsync(3000);

      const settled = await turn;
      expect(settled).toMatchObject({ kind: 'message' });
      expect(settled.text).toContain('in-process or Redis');
      expect(settled.text).not.toContain('143');
      expect(spawned.processes).toHaveLength(2);
      expect(spawned.lastArgs()).toContain('--resume');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still fails the turn its process dies in, without restarting it mid-turn', async () => {
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'prose'),
      (_written, proc) => proc.exit(143),
    ]);
    await svc.startConversation(request());

    const turn = await svc.continueConversation('Carry on', () => {});

    expect(turn).toMatchObject({ kind: 'message', failed: true });
    expect(turn.text).toContain('exited with code 143');
    expect(spawned.processes).toHaveLength(1);
  });

  it('respawns nothing for a conversation reset, even once its process has ended', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose'), fixture('claude-code', 'prose')]);
    await svc.startConversation(request());
    spawned.processes[0].exit(143);
    svc.reset();

    await expect(svc.continueConversation('Carry on', () => {})).rejects.toThrow('No active planner conversation');
    expect(spawned.processes).toHaveLength(1);
  });

  it('names the refused tool when the agent ends its turn without replying', async () => {
    // Agents can stop on a refusal and say nothing. "Empty reply" told the user
    // nothing they could act on; the denial is the actual reason.
    const { svc } = service('claude-code', reachingFor('Write', { file_path: '/etc/hosts' }, undefined, '', 4));
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
      { type: 'assistant_text_delta', runId: 'r1', text: 'Which ' },
      { type: 'assistant_text_delta', runId: 'r1', text: 'stor' },
      { type: 'assistant_text', runId: 'r1', text: 'Which store?' },
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
      { type: 'assistant_text_delta', runId: 'r1', text: 'Which ' },
      { type: 'assistant_text_delta', runId: 'r1', text: 'store?' },
      { type: 'assistant_text', runId: 'r1', text: 'Which store?' },
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
      { type: 'assistant_text_delta', runId: 'r1', text: 'Let me look. ' },
      { type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 'c1', name: 'Read', output: 'x', success: true },
      { type: 'assistant_text_delta', runId: 'r2', text: 'Found it.' },
      { type: 'assistant_text', runId: 'r2', text: 'Found it.' },
      { type: 'turn_end' },
    ]);

    const turn = await svc.startConversation(request());

    expect(turn.text).toBe('Let me look. \n\nFound it.');
  });

  it('tags subagent activity with its subagent and keeps it out of the reply', async () => {
    const svc = scripted([
      { type: 'assistant_text', runId: 'r1', text: 'Delegating. ' },
      { type: 'tool_call', id: 'task-1', name: 'Task', args: { prompt: 'find the cache' } },
      { type: 'thinking_delta', text: 'grep ', subagentId: 'sa1' },
      { type: 'thinking', text: 'grep first', subagentId: 'sa1' },
      { type: 'tool_call', id: 'c1', name: 'Grep', args: { pattern: 'cache' }, subagentId: 'sa1' },
      { type: 'tool_result', id: 'c1', name: 'Grep', output: 'src/cache.ts', success: true, subagentId: 'sa1' },
      { type: 'tool_result', id: 'task-1', name: 'Task', output: 'It is in src/cache.ts', success: true },
      { type: 'assistant_text_delta', runId: 'r2', text: 'It is in src/cache.ts.' },
      { type: 'turn_end' },
    ]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.text).toBe('Delegating. \n\nIt is in src/cache.ts.');
    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas.map((e) => e.text)).toEqual(['Delegating. ', 'It is in src/cache.ts.']);
    // The subagent's Task call commits the planner's run, so its reply after
    // the call is a fresh segment — never the same one the delegation opened.
    expect(deltas[0].segmentId).not.toBe(deltas[1].segmentId);
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'grep ', subagentId: 'sa1' }]);
    expect(events.find((e) => e.type === 'tool_call' && e.toolCallId === 'c1')?.subagentId).toBe('sa1');
    expect(events.find((e) => e.type === 'tool_result' && e.toolCallId === 'c1')?.subagentId).toBe('sa1');
    const steps = turn.researchLog.filter((e): e is ResearchStep => !('type' in e));
    // In the order the calls were announced, so a reload draws them there.
    expect(steps.map((step) => [step.toolCallId, step.subagentId])).toEqual([['task-1', undefined], ['c1', 'sa1']]);
  });

  it('settles a reply that looks like a botched plan as prose, with no corrective re-emit', async () => {
    const broken = '{"tasks":[{"id":"t1","order":1,"title":"A","description":"d","type":"ai","dependencies":[],"subtasks":[]}]}';
    const svc = scripted(
      [{ type: 'assistant_text', runId: 'r1', text: broken }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r1', text: planJson() }, { type: 'turn_end' }],
    );
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn).toMatchObject({ kind: 'message', text: broken });
    // Settled where it streamed, as any prose reply is (ADR-0017 A1).
    expect(events.map((e) => e.type)).toEqual(['text_delta']);
  });

  it('nudges an agent whose reply was empty, and settles on the answer alone', async () => {
    const svc = scripted(
      [{ type: 'assistant_text_delta', runId: 'r1', text: '\n' }, { type: 'assistant_text', runId: 'r1', text: '' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r1', text: 'Which store?' }, { type: 'turn_end' }],
    );
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn.text).toBe('Which store?');
    // The empty reply's whitespace never shows (ReplySplitter holds it), so
    // there is nothing to take back, and the answer settles where it streamed.
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'text_delta']);
    expect(turn.runs?.map((run) => run.text)).toEqual(['Which store?']);
  });

  it('reports subagent lifecycle and usage, the subagent\'s share carried on its finish', async () => {
    const svc = scripted([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'find the cache', model: 'haiku' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 300, outputTokens: 20, subagentId: 'sa1' } },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 100, subagentId: 'sa1' } },
      { type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'src/cache.ts' },
      { type: 'usage', record: { source: 'claude-code', inputTokens: 5000, outputTokens: 80, reportedCost: { amount: 0.04, currency: 'USD' } } },
      { type: 'assistant_text', runId: 'r1', text: 'It is in src/cache.ts.' },
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
      [started, started, { type: 'assistant_text', runId: 'r1', text: 'Looking.' }, { type: 'turn_end' }],
      [finished, started, finished, { type: 'subagent_finished', subagentId: 'ghost', outcome: 'failed', digest: '' }, { type: 'assistant_text', runId: 'r1', text: 'Found it.' }, { type: 'turn_end' }],
    );
    const { events, onProgress } = collector();

    await svc.startConversation(request({ onProgress }));
    await svc.continueConversation('go on', onProgress);

    expect(events.filter((e) => e.type === 'subagent_started' || e.type === 'subagent_finished').map((e) => `${e.type}:${e.subagentId}`))
      .toEqual(['subagent_started:sa1', 'subagent_finished:sa1']);
  });
});

describe('CliAgentAiService — a usage limit the agent says twice (#79)', () => {
  function scripted(...turns: AgentEvent[][]) {
    return new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      createAdapter: scriptedAdapter(turns),
      workspaceRoot: () => '/repo',
      mcpServer: fakeMcpServer(),
    });
  }

  const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";

  it('shows the limit once, as the failure', async () => {
    // The assistant block and the error `result` word it alike but for a final period.
    const { svc } = service('claude-code', [claudeHitsLimit(limit, `${limit}.`)]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn).toMatchObject({ kind: 'message', text: `${limit}.`, failed: true });
    expect(shownReply(events)).toBe('');
  });

  it('takes back a streamed copy of the limit too', async () => {
    const svc = scripted([
      { type: 'assistant_text_delta', runId: 'r1', text: limit },
      { type: 'assistant_text', runId: 'r1', text: limit },
      { type: 'error', message: `${limit}.` },
    ]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn).toMatchObject({ kind: 'message', text: `${limit}.`, failed: true });
    expect(shownReply(events)).toBe('');
  });

  it('keeps a real reply that came before the failure, beside the error', async () => {
    const { svc } = service('claude-code', [claudeHitsLimit(limit, `${limit}.`, 'The cache belongs in src/cache.ts.')]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn).toMatchObject({ kind: 'message', failed: true, text: `The cache belongs in src/cache.ts.\n\n${limit}.` });
    // The settled failure replaces the final segment, so nothing is left streamed beside it.
    expect(shownReply(events)).toBe('');
  });

  it('leaves an earlier segment of the reply showing, with the failure after it', async () => {
    const svc = scripted([
      { type: 'assistant_text', runId: 'r1', text: 'Reading the cache.' },
      { type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'src/cache.ts' } },
      { type: 'tool_result', id: 'c1', name: 'Read', output: 'export {}', success: true },
      { type: 'assistant_text', runId: 'r2', text: limit },
      { type: 'error', message: `${limit}.` },
    ]);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress }));

    expect(turn).toMatchObject({ kind: 'message', failed: true, text: `${limit}.` });
    expect(shownReply(events)).toBe('Reading the cache.');
  });

  it('keeps reply text that only mentions the failure', async () => {
    const svc = scripted([
      { type: 'assistant_text', runId: 'r1', text: `I stopped early: ${limit}` },
      { type: 'error', message: limit },
    ]);

    const turn = await svc.startConversation(request());

    expect(turn.text).toBe(`I stopped early: ${limit}\n\n${limit}`);
  });

  it('keeps an unrelated reply that came before the failure, beside it', async () => {
    const svc = scripted([
      { type: 'assistant_text', runId: 'r1', text: 'Which store should the cache use?' },
      { type: 'error', message: `${limit}.` },
    ]);

    const turn = await svc.startConversation(request());

    expect(turn).toMatchObject({
      kind: 'message',
      failed: true,
      text: `Which store should the cache use?\n\n${limit}.`,
    });
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
    // The thread is opened read-only, its approvals asked of Ordewell (ADR-0026).
    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.method).toBe('thread/start');
    expect(threadStart.params.sandbox).toBe('read-only');
    expect(threadStart.params.approvalPolicy).toBe('on-request');
  });

  // The policy decides Codex's own search once, as its thread starts (ADR-0027).
  it.each([
    ['on, cached, where the policy would search unasked', true, 'cached'],
    ['off where it would ask', false, 'disabled'],
  ])('opens the thread with its built-in search %s', async (_label, unasked, mode) => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools')]);
    const searchesUnasked = vi.fn(() => unasked);
    const fetcher = { decide: async () => ({ allowed: false as const, reason: 'no' }), fetch: async () => ({ success: false, output: '', truncated: false }), searchesUnasked };
    await svc.startConversation(request({ runners: ['codex'], approval: { request: async () => false }, fetcher }));

    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.params.config.web_search).toBe(mode);
    expect(searchesUnasked).toHaveBeenCalledWith('openai');
  });

  it('opens the thread with its built-in search off when nobody could approve a read', async () => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools')]);
    const fetcher = { decide: async () => ({ allowed: true as const }), fetch: async () => ({ success: true, output: '', truncated: false }), searchesUnasked: () => true };
    await svc.startConversation(request({ runners: ['codex'], fetcher }));

    expect(JSON.parse(spawned.processes[0].written[1]).params.config.web_search).toBe('disabled');
  });

  /** A fetcher whose session-wide search decision is `unasked()`, asked fresh each time. */
  const searchFetcher = (unasked: () => boolean) => ({
    decide: async () => ({ allowed: false as const, reason: 'no' }),
    fetch: async () => ({ success: false, output: '', truncated: false }),
    searchesUnasked: vi.fn(unasked),
  });
  const approval = { request: async () => false };

  it('adds what a child\'s grants withhold to what its runner carries itself (ADR-0056 M6)', async () => {
    const mcp = fakeMcpServer();
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'tools')], {}, {}, mcp);
    const offered = request({ runners: ['codex'], approval, fetcher: searchFetcher(() => true) });
    await svc.startConversation({ ...offered, plannerTools: { ...offered.plannerTools!, withheld: ['merge_all', 'run_script'] } });

    expect(mcp.plannerScopes[0].hidden).toEqual(['web_search', 'merge_all', 'run_script']);
  });

  it.each([
    ['on: the token hides Ordewell\'s web_search', true, 'cached', ['web_search']],
    ['off: Ordewell\'s web_search is served instead', false, 'disabled', []],
  ])('gives the token and the thread one search decision — %s, and fetch either way', async (_label, unasked, mode, hidden) => {
    const mcp = fakeMcpServer();
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools')], {}, {}, mcp);
    await svc.startConversation(request({ runners: ['codex'], approval, fetcher: searchFetcher(() => unasked) }));

    expect(mcp.plannerScopes[0].hidden).toEqual(hidden);
    const thread = JSON.parse(spawned.processes[0].written[1]).params as { config: { web_search: string }; developerInstructions: string };
    expect(thread.config.web_search).toBe(mode);
    expect(thread.developerInstructions.includes('mcp__ordewell__web_search')).toBe(!unasked);
    expect(thread.developerInstructions).toContain('mcp__ordewell__fetch');
  });

  // The policy flipping between the token and the thread config must not split them.
  it('asks the policy once per spawn, so a flip between token and thread cannot split them', async () => {
    const mcp = fakeMcpServer();
    let calls = 0;
    const { svc, spawned } = service('codex', [...codexHandshake(), ...codexHandshake(), fixture('codex', 'tools')], {}, {}, mcp);
    await svc.startConversation(request({ runners: ['codex'], approval, fetcher: searchFetcher(() => ++calls === 1) }));

    expect(mcp.plannerScopes[0].hidden).toEqual(['web_search']);
    expect(JSON.parse(spawned.processes[0].written[1]).params.config.web_search).toBe('cached');
    // The flip is seen before the turn, which runs on a thread respawned with search off.
    expect(mcp.revoked).toContain('tok-1');
    expect(mcp.plannerScopes[1].hidden).toEqual([]);
    expect(JSON.parse(spawned.processes[1].written[1]).params.config.web_search).toBe('disabled');
    expect(spawned.processes[0].written.some((line) => line.includes('"turn/start"'))).toBe(false);
  });

  // Full→Guarded, a `!web_search:*` exclusion or a zero budget between turns (ADR-0027).
  it('reopens the thread with search off, and Ordewell\'s web_search served, once the policy stops allowing it', async () => {
    const mcp = fakeMcpServer();
    let unasked = true;
    const { svc, spawned } = service('codex', [
      ...codexHandshake(), fixture('codex', 'tools'),
      fixture('codex', 'handshake'), fixture('codex', 'new-conversation'), fixture('codex', 'tools'),
    ], {}, {}, mcp);
    await svc.startConversation(request({ runners: ['codex'], approval, fetcher: searchFetcher(() => unasked) }));
    unasked = false;
    await svc.continueConversation('Carry on', () => {});

    expect(spawned.processes).toHaveLength(2);
    expect(mcp.revoked).toContain('tok-1');
    expect(mcp.plannerScopes.map((scope) => scope.hidden)).toEqual([['web_search'], []]);
    const resume = JSON.parse(spawned.processes[1].written[1]);
    expect(resume.method).toBe('thread/resume');
    expect(resume.params.threadId).toBe('thr-codex-1');
    expect(resume.params.config.web_search).toBe('disabled');
    expect(resume.params.developerInstructions).toContain('search with `mcp__ordewell__web_search`');
  });

  it('keeps the running thread while the decision stands', async () => {
    const mcp = fakeMcpServer();
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools'), fixture('codex', 'tools').replaceAll('turn-1', 'turn-2')], {}, {}, mcp);
    await svc.startConversation(request({ runners: ['codex'], approval, fetcher: searchFetcher(() => true) }));
    await svc.continueConversation('Carry on', () => {});

    expect(spawned.processes).toHaveLength(1);
    expect(mcp.issued).toHaveLength(1);
    expect(mcp.revoked).toEqual([]);
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

  it('returns a plan in an agent_message as prose', async () => {
    const { svc } = service('codex', [...codexHandshake(), fixture('codex', 'plan', { PLAN: planJson('codex') })]);
    const turn = await svc.startConversation(request({ runners: ['codex'] }));

    expect(turn).toMatchObject({ kind: 'message', text: planJson('codex') });
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

  it('plans with Codex\'s own shell off when no sandbox backend works', async () => {
    const { svc, spawned } = service(
      'codex',
      [fixture('codex', 'handshake-warning'), fixture('codex', 'new-conversation'), fixture('codex', 'tools')],
      {},
      { probe: () => ({ code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }) },
    );
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress, runners: ['codex'] }));

    // Stock Ubuntu 24.04 restricts the user namespaces Codex's sandbox needs.
    // Refusing there made Codex unusable as a planner, though `run_command`
    // reads the workspace without Codex's own shell.
    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.params.config.features).toEqual({ shell_tool: false, unified_exec: false });
    expect(threadStart.params.sandbox).toBe('read-only');
    expect(threadStart.params.developerInstructions).toContain('You have no shell of your own on this machine');
    const thinking = events.filter((e) => e.type === 'thinking').map((e) => e.text);
    expect(thinking.filter((text) => text?.includes('its own shell is off for planning'))).toHaveLength(1);
    expect(thinking.join('\n')).toContain('apparmor_restrict_unprivileged_userns=0');
    expect(thinking.join('\n')).not.toContain('Codex configuration warning');
  });

  it('keeps Codex\'s own shell when its sandbox starts', async () => {
    const { svc, spawned } = service('codex', [...codexHandshake(), fixture('codex', 'tools')]);
    await svc.startConversation(request({ runners: ['codex'] }));

    const threadStart = JSON.parse(spawned.processes[0].written[1]);
    expect(threadStart.params.config.features).toBeUndefined();
    expect(threadStart.params.developerInstructions).toContain('not your own shell');
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

  it('resumes the thread when the app-server ended between turns', async () => {
    const { svc, spawned } = service('codex', [
      ...codexHandshake(),
      fixture('codex', 'tools'),
      fixture('codex', 'handshake'),
      fixture('codex', 'new-conversation'),
      fixture('codex', 'tools'),
    ]);
    await svc.startConversation(request({ runners: ['codex'] }));
    spawned.processes[0].exit(143);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const turn = await svc.continueConversation('Carry on', () => {});

    expect(turn).toMatchObject({ kind: 'message' });
    expect(turn.text).not.toContain('143');
    const resume = JSON.parse(spawned.processes[1].written[1]);
    expect(resume.method).toBe('thread/resume');
    expect(resume.params.threadId).toBe('thr-codex-1');
  });

  it('discards a rejected resume before sending into a fresh thread without its transcript', async () => {
    const controller = new AbortController();
    const { svc, spawned } = service('codex', [
      ...codexHandshake(),
      () => { controller.abort(); },
      fixture('codex', 'handshake'),
      fixture('codex', 'resume-rejected'),
      // The fallback is the connection's third request, so Codex answers it under id 3.
      fixture('codex', 'new-conversation').replace('"id":2,', '"id":3,').replaceAll('thr-codex-1', 'thr-codex-new'),
      fixture('codex', 'tools').replaceAll('thr-codex-1', 'thr-codex-new'),
    ]);
    await svc.startConversation(request({ runners: ['codex'], signal: controller.signal }));
    await expect(svc.continueConversation('Carry on', () => {})).rejects.toThrow('could not be resumed');

    const methods = spawned.processes[1].written.map((line) => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'thread/resume', 'thread/start']);
    expect(svc.hasActiveConversation()).toBe(false);
    expect(spawned.processes[1].killed).toBe(true);
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
    // Codex's own count of the context a call leaves: `total_tokens`, input
    // plus output. Reasoning is part of output and stays in Codex's count.
    expect(usage.map((r) => r.contextTokens)).toEqual([13345, 13384]);
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
   * raises its permission requests. Omitted, the stream stays open without
   * emitting frames.
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
  // as any runner's several runs of text would.
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

  it('returns a plan carried in a text part as prose', async () => {
    const { svc } = openCodeService((url) => {
      if (url.endsWith('/session')) return { id: 'ses_opencode_2' };
      return { info: { id: 'msg_a' }, parts: [{ id: 'prt_1', messageID: 'msg_a', type: 'text', text: planJson('opencode') }] };
    });

    const turn = await svc.startConversation(request({ runners: ['opencode'] }));
    expect(turn).toMatchObject({ kind: 'message', text: planJson('opencode') });
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
      if (url.endsWith('/event')) return sseResponse(init).response;
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

  // ADR-0012 T10: a compaction may take the plan block out of the planner's context.
  it('counts a compaction of its own session, and not another session\'s', async () => {
    const compacted = (sessionID: string) => `data: ${JSON.stringify({ type: 'session.compacted', properties: { sessionID } })}\n`;
    const { svc } = openCodeService(
      (url) => {
        if (url.endsWith('/session')) return { id: 'ses_mine' };
        return new Promise((resolve) => setTimeout(() => resolve({ info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] }), 0));
      },
      [compacted('ses_someone_else'), compacted('ses_mine')],
    );

    expect(svc.compactions()).toBe(0);
    await svc.startConversation(request({ runners: ['opencode'] }));

    expect(svc.compactions()).toBe(1);
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

  it('discards a missing session before sending into a fresh session without its transcript', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    let firstTurn = true;
    let created = 0;
    const { svc } = openCodeService((url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/session') && init?.method === 'POST') return { id: `ses_${++created}` };
      if (url.endsWith('/session/ses_1')) return null;
      if (firstTurn) { firstTurn = false; controller.abort(); return {}; }
      return { info: { id: 'msg_a' }, parts: [{ id: 'p1', messageID: 'msg_a', type: 'text', text: 'ok' }] };
    });

    await svc.startConversation(request({ runners: ['opencode'], signal: controller.signal }));
    await expect(svc.continueConversation('Carry on', () => {})).rejects.toThrow('could not be resumed');

    // The stale id is probed, found missing, and replaced rather than used.
    expect(seen).toContain('GET /session/ses_1');
    expect(seen.filter((s) => s === 'POST /session')).toHaveLength(2);
    expect(seen).not.toContain('POST /session/ses_2/message');
    expect(svc.hasActiveConversation()).toBe(false);
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

  // In the recording the planner's first text part streamed before its `task`
  // call and completed only after the call had started. Recorded as nothing but
  // newlines; given words, it is the text a late completion used to repeat.
  it('keeps text that began before a tool call above it, once, when its completion arrives after the call', async () => {
    const said = 'I will have a subagent read it.';
    const early = 'prt_0e0161564001KdeNCS3UUcJpRp';
    const { sessionId, frames, response } = openCodeFixture('subagent');
    const worded = frames.map((frame) => {
      const event = JSON.parse(frame.slice('data: '.length)) as { properties: { partID?: string; delta?: string; part?: { id?: string; text?: string } } };
      if (event.properties.partID === early) event.properties.delta = said;
      else if (event.properties.part?.id === early && event.properties.part.text) event.properties.part.text = said;
      else return frame;
      return `data: ${JSON.stringify(event)}\n\n`;
    });
    const { svc } = openCodeService((url) => {
      if (url.endsWith('/session')) return { id: sessionId };
      return new Promise((resolve) => setTimeout(() => resolve(response), 0));
    }, worded);
    const { events, onProgress } = collector();

    const turn = await svc.startConversation(request({ onProgress, runners: ['opencode'] }));

    expect(turn.text).toBe(`${said}\n\n\`math.ts\` exports a single function \`add(a: number, b: number): number\`.`);
    const call = events.findIndex((e) => e.type === 'tool_call' && e.toolArgs?.includes('Read math.ts'));
    const streamed = events.flatMap((e, i) => (e.type === 'text_delta' && e.text === said ? [i] : []));
    expect(streamed).toHaveLength(1);
    expect(streamed[0]).toBeLessThan(call);
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
  it('generates the plan its submit_plan call recorded, through a Claude Code session that does not outlive it', async () => {
    const mcp = fakeMcpServer();
    const answers: McpToolReply[] = [];
    const { svc, spawned } = service('claude-code', [submitting(mcp, planTasks(), claudeSays('Submitted the plan.'), answers)], {}, {}, mcp);
    const result = await svc.researchAndPlan(
      'Add the thing',
      ['claude-code'],
      { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [] }] },
      fakeFileSystem(),
      () => {},
    );

    expect(answers.map((a) => a.isError ?? false)).toEqual([false]);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].assignedRunner).toBe('claude-code');
    expect(result.researchLog[0]).toMatchObject({ type: 'user_prompt', content: 'Add the thing' });
    expect(spawned.processes[0].killed).toBe(true);
    expect(svc.hasActiveConversation()).toBe(false);
  });

  // Live, Haiku backgrounded its Explore agents and ended the turn "waiting
  // for results"; the session was then thrown away with the plan unsubmitted.
  it('asks an agent that ended its turn with a subagent in the background to wait for it, in the same session', async () => {
    const mcp = fakeMcpServer();
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'stream-async-agent'),
      submitting(mcp, planTasks(), claudeSays('Submitted the plan.')),
    ], {}, {}, mcp);
    const result = await svc.researchAndPlan('Add the thing', ['claude-code'], { 'claude-code': [] }, fakeFileSystem(), () => {});

    expect(result.tasks).toHaveLength(1);
    expect(spawned.processes).toHaveLength(1);
    expect(writes(spawned.processes[0])).toHaveLength(2);
    expect(writes(spawned.processes[0])[1]).toContain('still running in the background');
    expect(writes(spawned.processes[0])[1]).toContain('submit the plan with submit_plan');
  });

  // The plan display a vendor planner's one-shot feeds token by token. The
  // agent's narration around an envelope is prose, which a one-shot does not
  // stream; the plan itself is the one submit_plan recorded.
  it('streams an envelope in the reply to the plan display, and nothing of the narration', async () => {
    const plan = planJson();
    const mcp = fakeMcpServer();
    const scripted = scriptedAdapter([[
      { type: 'assistant_text', runId: 'r1', text: 'Here is the plan.' },
      { type: 'tool_call', id: 'c1', name: 'Read', args: { file_path: 'README.md' } },
      { type: 'tool_result', id: 'c1', name: 'Read', output: '# App', success: true },
      { type: 'assistant_text_delta', runId: 'r2', text: plan.slice(0, 40) },
      { type: 'assistant_text_delta', runId: 'r2', text: plan.slice(40) },
      { type: 'assistant_text', runId: 'r2', text: plan },
      { type: 'turn_end' },
    ]]);
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      // The turn submits through the token its session was issued, as an agent's tool call would.
      createAdapter: (runner, deps) => {
        const adapter = scripted(runner, deps)!;
        return {
          ...adapter,
          send: async (message, onEvent, signal) => {
            await mcp.plannerHandlers.at(-1)!.submitPlan!({ tasks: planTasks() as SubmitPlanArgs['tasks'] }, { signal: new AbortController().signal });
            return adapter.send(message, onEvent, signal);
          },
        };
      },
      workspaceRoot: () => '/repo',
      mcpServer: mcp,
    });
    const tokens: string[] = [];

    expect(await svc.generatePlanDirect('Add the thing', ['claude-code'], {}, (token) => tokens.push(token))).toHaveLength(1);
    expect(tokens.join('')).toBe(plan);
  });

  it('generates the plan its submit_plan call recorded through a Codex session', async () => {
    const mcp = fakeMcpServer();
    const { svc, spawned } = service('codex', [...codexHandshake(), submitting(mcp, planTasks('codex'), fixture('codex', 'plan', { PLAN: 'Submitted.' }))], {}, {}, mcp);
    const tasks = await svc.generatePlanDirect('Plan the thing', ['codex']);

    expect(tasks).toHaveLength(1);
    expect(spawned.processes[0].killed).toBe(true);
  });

  // The reply text has no authority: a plan the agent writes out, or echoes
  // after submit_plan refused it, is never read back in as the plan.
  it('fails clearly when no submit_plan call is accepted, after one corrective session, and never reads the reply\'s JSON', async () => {
    const { svc, spawned } = service('claude-code', [claudeSays(planJson()), claudeSays(planJson())]);

    await expect(svc.generatePlanDirect('Plan the thing', ['claude-code'])).rejects.toThrow(/claude-code planner produced no plan: no submit_plan call was accepted/);
    expect(spawned.processes).toHaveLength(2);
    expect(spawned.lastArgs().join('\n')).toContain('the agent ended its turn without calling submit_plan. Call submit_plan with the COMPLETE corrected plan');
    expect(spawned.processes.every((p) => p.killed)).toBe(true);
  });

  it('ignores the plan JSON an agent echoes after its submission was refused, and corrects through submit_plan', async () => {
    const mcp = fakeMcpServer();
    const answers: McpToolReply[] = [];
    const bad = [{ ...(planTasks() as Record<string, unknown>[])[0], assignedRunner: 'bogus' }];
    const { svc, spawned } = service('claude-code', [
      submitting(mcp, bad, claudeSays(planJson()), answers),
      submitting(mcp, planTasks(), claudeSays('Fixed and submitted.'), answers),
    ], {}, {}, mcp);

    const tasks = await svc.generatePlanDirect('Plan the thing', ['claude-code']);

    expect(answers.map((a) => a.isError ?? false)).toEqual([true, false]);
    const corrective = spawned.lastArgs().join('\n');
    expect(corrective).toContain('invalid assignedRunner');
    expect(corrective).toContain('A plan written in your reply is not read');
    expect(tasks[0].assignedRunner).toBe('claude-code');
  });

  it('refuses a submission attaching a planner skill in the agent\'s turn, and warns about names it cannot attach', async () => {
    const plannerSkill = { name: 'grilling', appliesTo: 'planner', path: '/home/u/.ordewell/skills/grilling/SKILL.md' } as SkillInfo;
    const taskSkills: SkillLookup = { findSkill: (name) => (name === 'grilling' ? plannerSkill : undefined), searchedDirs: () => [] };
    const nested = (skills: unknown[]) => [{ ...(planTasks() as Record<string, unknown>[])[0], subtasks: [{ id: 's1', order: 1, title: 'Sub', description: 'd', type: 'ai', skills }] }];
    const mcp = fakeMcpServer();
    const answers: McpToolReply[] = [];
    const { svc } = service('claude-code', [
      submitting(mcp, nested(['grilling']), claudeSays('Submitted.'), answers),
      submitting(mcp, nested(['Bad Name!', 'Later', 'later']), claudeSays('Submitted again.'), answers),
    ], {}, {}, mcp);

    const tasks = await svc.generatePlanDirect('Plan', ['claude-code'], {}, undefined, undefined, undefined, undefined, { autonomousDefault: true, isolatedExecution: false, taskSkills });

    expect(answers[0]).toEqual({ isError: true, text: expect.stringContaining('Task "Sub": "grilling" is a planner skill') });
    expect(JSON.parse(answers[1].text)).toEqual({
      ok: true,
      warnings: [
        expect.stringContaining('Task "Sub": "Bad Name!" is not a valid skill name'),
        expect.stringContaining('Task "Sub": skill "later" not found'),
      ],
      next: expect.any(String),
    });
    expect(tasks[0].subtasks[0].skills).toEqual(['later']);
  });

  it('surfaces a one-shot agent failure instead of returning an empty plan', async () => {
    const { svc } = service('claude-code', [
      (_written, proc) => {
        proc.emitStderr('Invalid API key · Please run /login');
        proc.exit(1);
      },
    ]);

    await expect(svc.generatePlanDirect('Plan the thing', ['claude-code'])).rejects.toThrow(/login|exited/i);
  });

  it('keeps a one-shot from becoming the open chat\'s resume hint', async () => {
    // A one-shot runs its own agent session. Letting its id become the resume
    // hint would restart the chat into a plan-generation session that never
    // shared its goal.
    const controller = new AbortController();
    const mcp = fakeMcpServer();
    const { svc, spawned } = service('claude-code', [
      (_written, proc) => {
        proc.emitStdout('{"type":"system","subtype":"init","session_id":"sess-chat"}\n');
        controller.abort();
      },
      submitting(mcp, planTasks(), '{"type":"system","subtype":"init","session_id":"sess-oneshot"}\n' + claudeSays('Submitted.')),
      fixture('claude-code', 'prose'),
    ], {}, {}, mcp);
    await svc.startConversation(request({ signal: controller.signal }));
    await svc.generatePlanDirect('Plan the thing', ['claude-code']);
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

  it('streams each run\'s deltas under its own segment, and joins the runs with a paragraph break', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'stream-tool-rounds')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    expect(plannerTokens(events)).toEqual([
      'I\'ll read README.md now', '.', 'The first line of README.md is', ' "hello".',
    ]);
    const segments = events.flatMap((e) => (e.type === 'text_delta' ? [e.segmentId] : []));
    expect(new Set(segments.slice(0, 2)).size).toBe(1);
    expect(segments[2]).not.toBe(segments[0]);
    expect(turn.text).toBe('I\'ll read README.md now.\n\nThe first line of README.md is "hello".');
  });

  // ADR-0017 A1: the runs settle where they streamed, so none is taken back.
  it('settles the reply with each run under its segment, the one before the Read as narration, and takes none back', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'stream-tool-rounds')]);
    const { events, onProgress } = collector();
    const turn = await svc.startConversation(request({ onProgress }));

    const segments = events.flatMap((e) => (e.type === 'text_delta' ? [e.segmentId] : []));
    expect(turn.runs).toEqual([
      { segmentId: segments[0], text: 'I\'ll read README.md now.', startedAt: expect.any(String), narration: true },
      { segmentId: segments[2], text: 'The first line of README.md is "hello".', startedAt: expect.any(String) },
    ]);
    expect(events.filter((e) => e.type === 'text_retracted')).toEqual([]);
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
  // cached one. The context a call leaves is that prompt and its reply, as
  // Claude Code itself counts it.
  it('reports each planner call\'s usage once, and the turn\'s cost with the context window', async () => {
    const { svc } = service('claude-code', [fixture('claude-code', 'stream-tool-rounds')]);
    const { events, onProgress } = collector();
    await svc.startConversation(request({ onProgress }));

    expect(usageRecords(events)).toEqual([
      { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 18604, cachedInputTokens: 9428, outputTokens: 162, contextTokens: 18766 },
      { source: 'claude-code', model: 'claude-sonnet-5', inputTokens: 20025, cachedInputTokens: 18602, outputTokens: 14, contextTokens: 20039 },
      { source: 'claude-code', model: 'claude-sonnet-5', aggregate: true, reportedCost: { amount: 0.049754, currency: 'USD', kind: 'estimate', basis: 'list' } },
      { source: 'claude-code', model: 'claude-sonnet-5', contextWindow: 1000000 },
    ]);
    const usage = usageRecords(events).reduce(addPlannerUsage, { totals: {} });
    expect(usage.totals).toEqual({
      inputTokens: 38629, cachedInputTokens: 28030, outputTokens: 176, reportedCost: { USD: 0.049754 }, costProvenance: { USD: { kind: 'estimate', billing: 'unknown', basis: 'list' } },
    });
    expect(plannerContextFill(usage)).toEqual({ usedTokens: 20039, windowTokens: 1000000 });
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

  it('counts on from what the process before a restartPlanner counted', async () => {
    const { svc, spawned } = service('claude-code', [
      fixture('claude-code', 'stream-reasoning'),
      fixture('claude-code', 'stream-reasoning-followup'),
    ]);
    const first = collector();
    await svc.startConversation(request({ onProgress: first.onProgress }));
    svc.restart();
    const second = collector();
    await svc.continueConversation('And 397?', second.onProgress);

    expect(spawned.lastArgs()).toContain('--resume');
    const costs = (events: ResearchProgress[]) => usageRecords(events).flatMap((r) => (r.reportedCost ? [r.reportedCost.amount] : []));
    expect(costs(second.events)).toEqual([expect.closeTo(0.0111424, 10)]);
  });

  it('attributes cumulative costs to the models in the runner report across a switch', async () => {
    const turn = (model: string, input: number, modelUsage: Record<string, { costUSD: number; contextWindow: number }>, total: number) => [
      { type: 'stream_event', event: { type: 'message_start', message: { model } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: input, output_tokens: 1 } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'result', subtype: 'success', total_cost_usd: total, modelUsage },
    ].map((line) => `${JSON.stringify(line)}\n`).join('');
    const { svc } = service('claude-code', [
      turn('a', 80, { a: { costUSD: 1, contextWindow: 100 } }, 1),
      turn('b', 10, { a: { costUSD: 1, contextWindow: 100 }, b: { costUSD: 2, contextWindow: 200 } }, 3),
    ]);
    const first = collector();
    await svc.startConversation(request({ onProgress: first.onProgress }));
    const second = collector();
    await svc.continueConversation('Use b', second.onProgress);
    const usage = [...usageRecords(first.events), ...usageRecords(second.events)].reduce(addPlannerUsage, { totals: {} });
    expect(usage.byModel?.find((m) => m.model === 'a')?.totals.reportedCost).toEqual({ USD: 1 });
    expect(usage.byModel?.find((m) => m.model === 'b')?.totals.reportedCost).toEqual({ USD: 2 });
    expect(usage.totals.reportedCost).toEqual({ USD: 3 });
    expect(plannerContextFill(usage)).toEqual({ usedTokens: 11, windowTokens: 200 });
  });

  // A resumed session restores its running total (recorded: 0.0943048 on the
  // first turn after `--resume`). The process before it counted nothing of it
  // — it died before any result — so all of it is this session's growth.
  it('counts the first turn after a resume from what the process before it counted', async () => {
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
    const costs = usageRecords(events).filter((r) => r.reportedCost);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ model: 'claude-sonnet-5', reportedCost: { currency: 'USD' } });
    expect(costs[0].reportedCost?.amount).toBeCloseTo(0.0943048, 10);
    expect(usageRecords(events).filter((r) => r.outputTokens !== undefined)).toHaveLength(1);
  });

  // A crashed process can end with a result whose totals are zeroed. The
  // resume after it restores the session's saved totals whole, so the count
  // carried across must not have dropped to 0 meanwhile.
  it('counts every dollar once across a crash that reported zeroed totals', async () => {
    const turn = (fields: object) => [
      { type: 'system', subtype: 'init', session_id: 'sess-crash' },
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-sonnet-5' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] } },
      { type: 'result', session_id: 'sess-crash', ...fields },
    ].map((l) => `${JSON.stringify(l)}\n`).join('');
    const usage = (costUSD: number) => ({ 'claude-sonnet-5': { costUSD, contextWindow: 200000 } });
    const { svc, spawned } = service('claude-code', [
      turn({ subtype: 'success', total_cost_usd: 2, modelUsage: usage(2) }),
      turn({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, modelUsage: usage(0) }),
      turn({ subtype: 'success', total_cost_usd: 2.5, modelUsage: usage(2.5) }),
    ]);
    const all: ResearchProgress[] = [];
    const onProgress = (p: ResearchProgress) => all.push(p);
    await svc.startConversation(request({ onProgress }));
    await svc.continueConversation('crash here', onProgress);
    await svc.continueConversation('and again', onProgress);

    expect(spawned.lastArgs()).toContain('--resume');
    const amounts = usageRecords(all).flatMap((r) => (r.reportedCost ? [r.reportedCost.amount] : []));
    expect(amounts).toEqual([2, 0.5]);
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
  it('kills the agent process on reset whether or not a conversation is still held', async () => {
    // The leak this guards: an agent process can outlive its conversation, so
    // a host that gated `reset()` on `hasActiveConversation()` disposed nothing.
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());
    expect(spawned.processes[0].killed).toBe(false);

    svc.reset();
    expect(spawned.processes[0].killed).toBe(true);
    expect(svc.hasActiveConversation()).toBe(false);
  });

  it('is idempotent, so callers never have to gate it', async () => {
    const { svc, spawned } = service('claude-code', [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    svc.reset();
    expect(() => { svc.reset(); svc.reset(); }).not.toThrow();
    expect(spawned.processes[0].killed).toBe(true);
  });

  /**
   * Planner processes as records: each one's start can be held open, and its
   * turn scripted. The server records what it issued and took back.
   */
  function planners(behave: (index: number) => { holdStart?: boolean; send?: AgentAdapter['send']; answerPermission?: AgentAdapter['answerPermission'] } = () => ({})) {
    const mcp = fakeMcpServer();
    const processes: Array<{ disposed: boolean; sent: string[]; release: () => void; startCalled: boolean }> = [];
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      workspaceRoot: () => '/repo',
      mcpServer: mcp,
      createAdapter: () => {
        const behavior = behave(processes.length);
        const record = { disposed: false, sent: [] as string[], release: () => {}, startCalled: false };
        processes.push(record);
        return {
          agentId: 'claude-code',
          exited: false,
          start: async () => {
            record.startCalled = true;
            if (behavior.holdStart) await new Promise<void>((resolve) => { record.release = resolve; });
          },
          send: async (message, onEvent, signal, onLiveness) => {
            record.sent.push(message);
            if (behavior.send) return behavior.send(message, onEvent, signal, onLiveness);
            onEvent({ type: 'assistant_text', runId: 'r1', text: `reply ${processes.indexOf(record) + 1}` });
            onEvent({ type: 'turn_end' });
          },
          nativeSessionId: () => null,
          dispose: () => { record.disposed = true; },
          mcpAttached: async () => true,
          answerPermission: behavior.answerPermission,
        };
      },
    });
    return { svc, mcp, processes };
  }

  it('takes back a planner whose start lands after a reset, rather than reviving its process and token', async () => {
    const { svc, mcp, processes } = planners(() => ({ holdStart: true }));
    const starting = svc.startConversation(request());
    await vi.waitFor(() => expect(processes[0]?.startCalled).toBe(true));

    svc.reset();
    processes[0].release();

    await expect(starting).rejects.toThrow();
    expect(processes[0]).toMatchObject({ disposed: true, sent: [] });
    expect(mcp.heldTokens()).toEqual([]);
    expect(svc.hasActiveConversation()).toBe(false);
    expect(svc.nativeSessionId()).toBeNull();
  });

  it('keeps the second conversation when the first one\'s start lands after it', async () => {
    const { svc, mcp, processes } = planners((index) => ({ holdStart: index === 0 }));
    const first = svc.startConversation(request({ goal: 'first' }));
    await vi.waitFor(() => expect(processes[0]?.startCalled).toBe(true));

    const second = await svc.startConversation(request({ goal: 'second' }));
    processes[0].release();
    await expect(first).rejects.toThrow();

    expect(second.text).toBe('reply 2');
    expect(processes[0]).toMatchObject({ disposed: true, sent: [] });
    expect(mcp.heldTokens()).toEqual(['tok-2']);
    const next = await svc.continueConversation('and then?', () => {});
    expect(next.text).toBe('reply 2');
    expect(processes).toHaveLength(2);
    expect(processes[1].sent).toHaveLength(2);
  });

  it('kills the planner and revokes its token when sending it a turn fails', async () => {
    const { svc, mcp, processes } = planners(() => ({ send: async () => { throw new Error('EPIPE'); } }));

    await expect(svc.startConversation(request())).rejects.toThrow('EPIPE');

    expect(processes[0].disposed).toBe(true);
    expect(mcp.heldTokens()).toEqual([]);
  });

  it('leaves no unhandled rejection when the planner cannot take a permission answer', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let answered = false;
      const { svc } = planners(() => ({
        send: async (_message, onEvent) => {
          onEvent({ type: 'permission_request', id: 'req-1', name: 'Write', detail: '/etc/hosts' });
          await vi.waitFor(() => expect(answered).toBe(true));
          onEvent({ type: 'assistant_text', runId: 'r1', text: 'ok' });
          onEvent({ type: 'turn_end' });
        },
        answerPermission: () => {
          answered = true;
          throw new Error('stdin closed');
        },
      }));

      await svc.startConversation(request({ approval: approvalSpy(false) }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('CliAgentAiService — the native-shell setting (ADR-0036)', () => {
  /** A service whose adapter reports `version`, with every start recorded. */
  function recordingService(turns: AgentEvent[][], version: () => string | null, config = fakeConfig({ aiProvider: 'claude-code' })) {
    const starts: PlannerStartOptions[] = [];
    const scripted = scriptedAdapter(turns);
    const mcp = fakeMcpServer();
    const svc = new CliAgentAiService(config, {
      createAdapter: (runner, deps): AgentAdapter => {
        const adapter = scripted(runner, deps)!;
        return { ...adapter, version, start: async (opts) => { if (opts.kind === 'planner') starts.push(opts); } };
      },
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      workspaceRoot: () => '/repo',
      platform: 'darwin',
      isDirectory: () => true,
      exists: () => true,
      mcpServer: mcp,
    });
    return { svc, starts, config };
  }

  it('carries the setting into every planner start, and reopens the process when it changes', async () => {
    const turns: AgentEvent[][] = [
      [{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r2', text: 'Two.' }, { type: 'turn_end' }],
    ];
    const config = fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: false });
    const { svc, starts } = recordingService(turns, () => '2.1.304', config);

    await svc.startConversation(request());
    expect(starts[0].nativeShell).toBe(false);

    config.plannerNativeShell = true;
    await svc.continueConversation('Go on', () => {});

    expect(starts).toHaveLength(2);
    expect(starts[1].nativeShell).toBe(true);
  });

  it('opens the process once for the checked version, then keeps it while the setting stands', async () => {
    const turns: AgentEvent[][] = [
      [{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r2', text: 'Two.' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r3', text: 'Three.' }, { type: 'turn_end' }],
    ];
    const { svc, starts } = recordingService(turns, () => '2.1.304', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }));

    await svc.startConversation(request());
    // The flag is decided before this process is asked for its version, so the
    // first process keeps run_command alone (ADR-0036 N2).
    expect(starts[0].nativeShell).toBe(false);

    await svc.continueConversation('Go on', () => {});
    expect(starts).toHaveLength(2);
    expect(starts[1].nativeShell).toBe(true);

    await svc.continueConversation('Still on', () => {});
    expect(starts).toHaveLength(2);
  });

  // The prompt is decided with the process, not with the setting: a planner
  // told of a shell it was not given spends calls on refusals (N1, N4).
  it('tells the planner of its own shell only in a process that was given one', async () => {
    const turns = (): AgentEvent[][] => [
      [{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r2', text: 'Two.' }, { type: 'turn_end' }],
    ];
    const told = (start: PlannerStartOptions) => (start.systemPrompt ?? '').includes('your own shell is available too');

    const checked = recordingService(turns(), () => '2.1.304', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }));
    await checked.svc.startConversation(request());
    await checked.svc.continueConversation('Go on', () => {});
    expect(checked.starts.map((start) => [start.nativeShell, told(start)])).toEqual([[false, false], [true, true]]);

    const unchecked = recordingService(turns(), () => '2.1.303', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }));
    await unchecked.svc.startConversation(request());
    await unchecked.svc.continueConversation('Go on', () => {});
    expect(unchecked.starts.map(told)).toEqual([false]);

    const codex = recordingService(turns(), () => '0.163.0', fakeConfig({ aiProvider: 'codex', plannerNativeShell: true }));
    await codex.svc.startConversation(request());
    expect(codex.starts.map(told)).toEqual([false]);
  });

  it('says once per session why the setting is not offered on an unchecked version', async () => {
    const turns: AgentEvent[][] = [
      [{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r2', text: 'Two.' }, { type: 'turn_end' }],
    ];
    const { svc } = recordingService(turns, () => '2.1.300', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }));
    const notices: Array<{ level: string; message: string }> = [];

    await svc.startConversation(request({ notice: (level, message) => notices.push({ level, message }) }));
    await svc.continueConversation('Go on', () => {});

    expect(notices).toHaveLength(1);
    expect(notices[0].level).toBe('warn');
    expect(notices[0].message).toContain('2.1.300');
  });

  it('says nothing when the checked version is offered, and nothing while the setting is off', async () => {
    const turns: AgentEvent[][] = [
      [{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }],
      [{ type: 'assistant_text', runId: 'r2', text: 'Two.' }, { type: 'turn_end' }],
    ];
    const notices: string[] = [];
    const offered = recordingService(turns, () => '2.1.304', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }));
    await offered.svc.startConversation(request({ notice: (_level, message) => notices.push(message) }));
    expect(notices).toEqual([]);

    const off = recordingService(turns, () => '2.1.300', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: false }));
    await off.svc.startConversation(request({ notice: (_level, message) => notices.push(message) }));
    expect(notices).toEqual([]);
  });

  it('reads Claude Code\'s version from its init line before the first tool call', async () => {
    const spawned = fakeSpawn([claudeVersionSays('2.1.300', 'Done.')]);
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }), {
      spawn: spawned.spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      workspaceRoot: () => '/repo',
      platform: 'darwin',
      isDirectory: () => true,
      exists: () => true,
      mcpServer: fakeMcpServer(),
    });
    const notices: string[] = [];

    await svc.startConversation(request({ notice: (_level, message) => notices.push(message) }));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Claude Code 2.1.300');
  });

  it('records every native shell command and its result as a bash step on the timeline (N2.3, N6)', async () => {
    const { svc } = recordingService([[
      { type: 'tool_call', id: 'cmd-1', name: 'Bash', args: { command: 'for f in *; do echo "$f"; done' } },
      { type: 'tool_result', id: 'cmd-1', name: 'Bash', output: 'a\nsrc', success: true },
      { type: 'tool_call', id: 'cmd-2', name: 'Monitor', args: { command: 'tail -f log' } },
      { type: 'tool_result', id: 'cmd-2', name: 'Monitor', output: 'line', success: true },
      { type: 'assistant_text', runId: 'r1', text: 'Done.' },
      { type: 'turn_end' },
    ]], () => '2.1.304', fakeConfig({ aiProvider: 'claude-code', plannerNativeShell: true }));

    const turn = await svc.startConversation(request());

    const steps = turn.researchLog.filter((step): step is ResearchStep => !('type' in step));
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ tool: 'bash', toolLabel: 'Bash', success: true, result: 'a\nsrc' });
    expect(JSON.parse(steps[0].args)).toMatchObject({ command: 'for f in *; do echo "$f"; done' });
    expect(steps[1]).toMatchObject({ tool: 'bash', toolLabel: 'Monitor', success: true, result: 'line' });
  });

  it('offers OpenCode 2.x its own shell once its server has reported a checked version, before the first turn', async () => {
    const turns: AgentEvent[][] = [[{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }]];
    const { svc, starts } = recordingService(turns, () => '2.0.32', fakeConfig({ aiProvider: 'opencode', plannerNativeShell: true }));

    await svc.startConversation(request());

    // The first process is spawned before /api/info answers; the second, made
    // once it has, is the one the first turn runs on.
    expect(starts.map((start) => start.nativeShell)).toEqual([false, true]);
  });

  it('tells an OpenCode 1.x user that the opt-in was checked on 2.0.32', async () => {
    const turns: AgentEvent[][] = [[{ type: 'assistant_text', runId: 'r1', text: 'One.' }, { type: 'turn_end' }]];
    const { svc } = recordingService(turns, () => null, fakeConfig({ aiProvider: 'opencode', plannerNativeShell: true }));
    const notices: string[] = [];

    await svc.startConversation(request({ notice: (_level, message) => notices.push(message) }));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('OpenCode 1.x');
  });

  it('records an OpenCode shell command and its result as a bash step (N2.3)', async () => {
    const { svc } = recordingService([[
      { type: 'tool_call', id: 'cmd-1', name: 'shell', args: { command: 'ls' } },
      { type: 'tool_result', id: 'cmd-1', name: 'shell', output: 'src', success: true },
      { type: 'assistant_text', runId: 'r1', text: 'Done.' },
      { type: 'turn_end' },
    ]], () => '2.0.32', fakeConfig({ aiProvider: 'opencode', plannerNativeShell: true }));

    const turn = await svc.startConversation(request());

    const steps = turn.researchLog.filter((step): step is ResearchStep => !('type' in step));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ tool: 'bash', toolLabel: 'shell', success: true, result: 'src' });
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

// ADR-0012 T10: a compaction may take the plan block out of the planner's
// context, so the conversation is told of each one the agent reports. The
// OpenCode case sits with its other server-event scenarios above.
describe('CliAgentAiService — compactions of the planner\'s own context', () => {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;

  it('counts Claude Code\'s compact boundary, and not a subagent\'s', async () => {
    const boundary = (extra: Record<string, unknown>) => line({ type: 'system', subtype: 'compact_boundary', session_id: 'sess-c', compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 9_000 }, ...extra });
    const turn = [
      line({ type: 'system', subtype: 'init', session_id: 'sess-c', cwd: '/repo', permissionMode: 'plan' }),
      boundary({ parent_tool_use_id: 'toolu_agent' }),
      boundary({}),
      line({ type: 'assistant', session_id: 'sess-c', message: { id: 'msg_c', role: 'assistant', content: [{ type: 'text', text: 'Carrying on.' }] } }),
      line({ type: 'result', subtype: 'success', session_id: 'sess-c', is_error: false, result: 'Carrying on.' }),
    ].join('');
    const { svc } = service('claude-code', [claudeSays('Which cache?'), turn]);

    await svc.startConversation(request());
    expect(svc.compactions()).toBe(0);
    await svc.continueConversation('Redis, please.', () => {});

    expect(svc.compactions()).toBe(1);
  });

  it('reports Claude Code\'s own compact boundary as an ended compaction with the sizes it gave, and never a subagent\'s', async () => {
    const boundary = (extra: Record<string, unknown>) => line({ type: 'system', subtype: 'compact_boundary', session_id: 'sess-c', compact_metadata: { trigger: 'auto', pre_tokens: 150_000, post_tokens: 9_000 }, ...extra });
    const turn = [
      line({ type: 'system', subtype: 'init', session_id: 'sess-c', cwd: '/repo', permissionMode: 'plan' }),
      boundary({ parent_tool_use_id: 'toolu_agent' }),
      boundary({}),
      line({ type: 'assistant', session_id: 'sess-c', message: { id: 'msg_c', role: 'assistant', content: [{ type: 'text', text: 'Carrying on.' }] } }),
      line({ type: 'result', subtype: 'success', session_id: 'sess-c', is_error: false, result: 'Carrying on.' }),
    ].join('');
    const { svc } = service('claude-code', [claudeSays('Which cache?'), turn]);
    const progress: ResearchProgress[] = [];

    await svc.startConversation(request());
    await svc.continueConversation('Redis, please.', (p) => progress.push(p));

    const compactions = progress.filter((p) => p.type === 'compaction').map((p) => p.compaction);
    expect(compactions).toEqual([{
      phase: 'ended', id: expect.any(String), origin: 'native', trigger: 'auto', outcome: 'condensed', at: expect.any(String), preTokens: 150_000, postTokens: 9_000,
    }]);
  });

  it('reports a Codex compaction from its completion alone, with no start and no size it never gave', async () => {
    const turn = [
      line({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-codex-1', turnId: 'turn-1' } }),
      line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-codex-1', turnId: 'turn-1', completedAtMs: 1, item: { id: 'item_mine', type: 'contextCompaction' } } }),
      line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-codex-1', turnId: 'turn-1', completedAtMs: 2, item: { id: 'item_m1', type: 'agentMessage', text: 'Carrying on.' } } }),
      line({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-codex-1', turn: { id: 'turn-1', status: 'completed', items: [] } } }),
    ].join('');
    const { svc } = service('codex', [...codexHandshake(), turn]);
    const progress: ResearchProgress[] = [];

    await svc.startConversation({ ...request({ runners: ['codex'] }), onProgress: (p) => progress.push(p) });

    expect(progress.filter((p) => p.type === 'compaction').map((p) => p.compaction)).toEqual([
      { phase: 'ended', id: expect.any(String), origin: 'native', trigger: 'auto', outcome: 'condensed', at: expect.any(String) },
    ]);
  });

  it('counts a Codex context compaction on its own thread, and not on another', async () => {
    const compaction = (threadId: string, id: string) => line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId: 'turn-1', completedAtMs: 1, item: { id, type: 'contextCompaction' } } });
    const turn = [
      line({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thr-codex-1', turnId: 'turn-1' } }),
      compaction('thr-unrelated', 'item_other'),
      compaction('thr-codex-1', 'item_mine'),
      line({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thr-codex-1', turnId: 'turn-1', completedAtMs: 2, item: { id: 'item_m1', type: 'agentMessage', text: 'Carrying on.' } } }),
      line({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thr-codex-1', turn: { id: 'turn-1', status: 'completed', items: [] } } }),
    ].join('');
    const { svc } = service('codex', [...codexHandshake(), turn]);

    await svc.startConversation(request({ runners: ['codex'] }));

    expect(svc.compactions()).toBe(1);
  });
});

describe('CliAgentAiService — a turn that says the agent is signed out', () => {
  function failing(error: string, provider: IConfig['aiProvider'] = 'claude-code', workspaceEnv?: () => Promise<Record<string, string>>): CliAgentAiService {
    return new CliAgentAiService(fakeConfig({ aiProvider: provider }), {
      createAdapter: scriptedAdapter([[{ type: 'error', message: error }, { type: 'turn_end' }]]),
      workspaceRoot: () => '/repo',
      ...(workspaceEnv ? { workspaceEnv } : {}),
      mcpServer: fakeMcpServer(),
    });
  }

  /** A HOME whose `~/.codex/config.toml` holds the given content. */
  function codexHomed(config: string): string {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-service-codex-'));
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'config.toml'), config);
    return root;
  }

  afterEach(() => resetRunnerAuth());

  it('records the runner signed out and puts the way back in ahead of its own words', async () => {
    const turn = await failing('Not logged in · Please run /login').startConversation(request());

    expect(turn).toMatchObject({
      kind: 'message',
      failed: true,
      text:
        'Claude Code not logged in. Sign in with /login, or run claude auth login and try again.\n\n' +
        'Not logged in · Please run /login',
    });
    expect(recordedRunnerAuth('claude-code', '/repo')).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
  });

  it('leaves an unrelated failure exactly as the runner said it', async () => {
    const turn = await failing('The repository is not a git repository').startConversation(request());

    expect(turn).toMatchObject({ kind: 'message', failed: true, text: 'The repository is not a git repository' });
    expect(recordedRunnerAuth('claude-code', '/repo')).toBeUndefined();
  });

  it('leaves a runner that declares no login alone, even when its words say not logged in', async () => {
    const turn = await failing('Not logged in · Please run /login', 'opencode').startConversation(request({ runners: ['opencode'] }));

    expect(turn).toMatchObject({ kind: 'message', failed: true, text: 'Not logged in · Please run /login' });
    expect(recordedRunnerAuth('opencode', '/repo')).toBeUndefined();
  });

  // Codex's own status only knows the credentials it stores itself. A custom
  // model_provider authenticates with its own env key, so the turn's "Not
  // logged in" is not this user's answer: recording it would wall a working
  // enterprise setup behind an irrelevant `codex login` (ADR-0016).
  it('leaves a Codex custom-provider failure alone, with no wrong login guidance', async () => {
    const home = codexHomed([
      'model = "gpt-5.4"',
      'model_provider = "azure"',
      '[model_providers.azure]',
      'name = "Azure"',
      'base_url = "https://example.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY"',
      'wire_api = "responses"',
      '',
    ].join('\n'));
    try {
      const turn = await failing('Not logged in\n', 'codex', () => Promise.resolve({ HOME: home, AZURE_OPENAI_API_KEY: 'sk-test' }))
        .startConversation(request({ runners: ['codex'] }));

      expect(turn).toMatchObject({ kind: 'message', failed: true, text: 'Not logged in\n' });
      expect(recordedRunnerAuth('codex', '/repo')).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('records a default Codex setup signed out from its failure line', async () => {
    const home = codexHomed('model = "gpt-5.4"\n');
    try {
      const turn = await failing('Not logged in\n', 'codex', () => Promise.resolve({ HOME: home }))
        .startConversation(request({ runners: ['codex'] }));

      expect(turn).toMatchObject({ kind: 'message', failed: true });
      expect(recordedRunnerAuth('codex', '/repo')).toEqual({
        state: 'signed-out',
        loginCommand: ['codex', 'login'],
        detail: 'not logged in',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
