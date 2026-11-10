import { describe, it, expect } from 'vitest';
import type { ResearchChat, ResearchTurn, ToolResult } from '../BaseAiService';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import { CONFINED_RESEARCH_TOOLS } from '../ResearchSubagents';
import { harnessResearchAgent, withResearchAgent, NO_TURN_OPEN } from '../harness/harnessResearchAgent';
import { PLANNER_RESEARCH_AGENT, PLANNER_TOOLS, plannerToolSet, toolListing, type PlannerToolHandler } from '../mcp/tools';
import { buildSubagentSystemPrompt, inTurnAgents } from '../PlanPrompts';
import { toOpenAiSubagentTools } from '../researchTools';

const textTurn = (text: string): ResearchTurn => ({ text, toolCalls: [], hasToolCalls: false });
const toolsTurn = (calls: [string, Record<string, unknown>][]): ResearchTurn => ({
  text: '', hasToolCalls: true, toolCalls: calls.map(([name, args], i) => ({ name, args, id: `c${i}` })),
});

/** One turn per call; usage reported on each model call, as a provider chat does. */
function scripted(turns: ResearchTurn[], onUsage?: (r: UsageRecord) => void, gate?: Promise<void>) {
  let i = 0;
  const received: ToolResult[][] = [];
  const next = async () => {
    await gate;
    onUsage?.({ inputTokens: 100, outputTokens: 10, model: 'cheap', contextTokens: 5000 } as UsageRecord);
    return turns[Math.min(i++, turns.length - 1)];
  };
  const chat: ResearchChat = {
    sendMessage: async () => next(),
    sendToolResults: async (results) => { received.push(results); return next(); },
  };
  return { chat, received };
}

function fakeFs(): { fs: IFileSystem; touched: string[] } {
  const touched: string[] = [];
  const ok = (name: string) => async (...args: unknown[]) => {
    touched.push(`${name}:${JSON.stringify(args[0])}`);
    return { success: true, output: `${name} output`, truncated: false };
  };
  const fs: IFileSystem = {
    readFile: ok('readFile'), readFiles: ok('readFiles'), glob: ok('glob'), grep: ok('grep'),
    findSymbol: ok('findSymbol'), listDir: ok('listDir'), bash: ok('bash'),
    getWorkspaceRoot: () => '/ws',
  };
  return { fs, touched };
}

const ctx = (signal = new AbortController().signal) => ({ signal });

describe('spawn_research_agent over MCP (ADR-0066)', () => {
  it('is listed only for a research scope, last, and leaves every other list unchanged byte for byte', () => {
    expect(plannerToolSet()).toBe(PLANNER_TOOLS);
    expect(plannerToolSet().some((t) => t.name === 'spawn_research_agent')).toBe(false);
    for (const scope of [{}, { delegates: true }, { subplanner: true }, { delegates: true, subplanner: true }]) {
      const without = toolListing(plannerToolSet(scope));
      const withIt = toolListing(plannerToolSet({ ...scope, research: true }));
      expect(withIt.slice(0, -1)).toEqual(without);
      expect(withIt.at(-1)?.name).toBe('spawn_research_agent');
      expect(JSON.stringify(withIt).startsWith(JSON.stringify(without).slice(0, -1))).toBe(true);
    }
    expect(PLANNER_RESEARCH_AGENT.annotations).toEqual({ readOnlyHint: true });
  });

  it('refuses every write, shell, web, edit and spawn call at dispatch: nothing reaches the filesystem', async () => {
    const { fs, touched } = fakeFs();
    const sink: ResearchProgress[] = [];
    let script!: ReturnType<typeof scripted>;
    let only: ReadonlySet<string> | undefined;
    const run = harnessResearchAgent({
      createChat: (_r, onUsage, tools) => {
        only = tools;
        script = scripted([
          toolsTurn([
            ['bash', { command: 'rm -rf /ws' }],
            ['write_file', { path: 'x', content: 'y' }],
            ['edit_file', { path: 'x', old: 'a', new: 'b' }],
            ['fetch', { url: 'https://example.com' }],
            ['web_search', { query: 'x' }],
            ['spawn_research_agent', { prompt: 'recurse' }],
            ['run_command', { command: 'ls' }],
            ['Agent', { prompt: 'x' }],
            ['apply_patch', { patch: '*** Add File: x' }],
            ['task', { prompt: 'a general subagent' }],
            // MCP tools, under the names a runner gives them: Ordewell's own and another server's.
            ['ordewell_run_command', { command: 'echo hi' }],
            ['mcp__ordewell__submit_plan', { tasks: [] }],
            ['probe_ping', {}],
          ]),
          textTurn('digest'),
        ], onUsage);
        return script.chat;
      },
      fs,
      turnSink: () => (p) => sink.push(p),
      newId: () => 'sa1',
    });
    const reply = await run({ prompt: 'try everything' }, ctx());
    expect(reply).toEqual({ text: 'digest' });
    expect(only).toBe(CONFINED_RESEARCH_TOOLS);
    expect(touched).toEqual([]);
    // What the model is offered: only the confined reads, so none of the above is a tool it could name.
    const offered = (toOpenAiSubagentTools(only) as { function: { name: string } }[]).map((t) => t.function.name).sort();
    expect(offered).toEqual([...CONFINED_RESEARCH_TOOLS].sort());
    const outputs = script.received[0].map((r) => r.output);
    expect(outputs).toHaveLength(13);
    for (const out of outputs) {
      expect(out).toMatch(/is not available/);
      expect(out).toContain('read_file, read_files, glob, grep, find_symbol, list_dir');
      expect(out.split("only tools are ")[1].split(".")[0]).not.toMatch(/\bbash\b|\bfetch\b|web_search|spawn_research_agent/);
    }
    // A refused call is never a step: no tool_call or tool_result was emitted for it.
    expect(sink.some((p) => p.type === 'tool_call' || p.type === 'tool_result')).toBe(false);
  });

  it('refuses reads outside the workspace and runs the ones inside', async () => {
    const { fs, touched } = fakeFs();
    let script!: ReturnType<typeof scripted>;
    const run = harnessResearchAgent({
      createChat: (_r, onUsage) => {
        script = scripted([
          toolsTurn([
            ['read_file', { path: '/etc/passwd' }],
            ['read_file', { path: '~/.ssh/id_rsa' }],
            ['read_file', { path: '../other/secret.env' }],
            ['read_files', { paths: ['src/a.ts', '/home/u/.aws/credentials'] }],
            ['grep', { pattern: 'token', path: '/home' }],
            ['list_dir', { path: '/' }],
            ['glob', { pattern: '**/*', path: '..' }],
            ['read_file', { path: 'src/a.ts' }],
          ]),
          textTurn('digest'),
        ], onUsage);
        return script.chat;
      },
      fs,
      turnSink: () => () => {},
    });
    await run({ prompt: 'reach out' }, ctx());
    const outputs = script.received[0].map((r) => r.output);
    for (const out of outputs.slice(0, 7)) expect(out).toMatch(/outside the workspace/);
    expect(outputs[7]).toBe('readFile output');
    expect(touched).toEqual(['readFile:"src/a.ts"']);
  });

  it('files its steps and usage under its own subagent id in the open turn, and sums its usage when it finishes', async () => {
    const { fs } = fakeFs();
    const sink: ResearchProgress[] = [];
    const run = harnessResearchAgent({
      createChat: (_r, onUsage) => scripted([toolsTurn([['grep', { pattern: 'x' }]]), textTurn('found it')], onUsage).chat,
      fs,
      model: 'cheap',
      turnSink: () => (p) => sink.push(p),
      newId: () => 'sa-7',
    });
    await run({ prompt: 'where is x' }, ctx());
    expect(sink[0]).toEqual({ type: 'subagent_started', subagentId: 'sa-7', brief: 'where is x', model: 'cheap' });
    const usages = sink.filter((p) => p.type === 'usage');
    expect(usages).toHaveLength(2);
    for (const u of usages) {
      expect(u.record?.subagentId).toBe('sa-7');
      expect(u.record).not.toHaveProperty('contextTokens');
    }
    const step = sink.find((p) => p.type === 'tool_result');
    expect(step?.step?.subagentId).toBe('sa-7');
    const finished = sink.at(-1)!;
    expect(finished).toMatchObject({ type: 'subagent_finished', subagentId: 'sa-7', outcome: 'done', digest: 'found it' });
    expect(finished.usage).toMatchObject({ inputTokens: 200, outputTokens: 20 });
  });

  it('refuses a call while no turn is open, before any model call', async () => {
    let built = 0;
    const run = harnessResearchAgent({ createChat: () => { built++; return null; }, fs: fakeFs().fs, turnSink: () => undefined });
    expect(await run({ prompt: 'x' }, ctx())).toEqual({ text: NO_TURN_OPEN, isError: true });
    expect(built).toBe(0);
  });

  it('reports a provider with no subagent chat as a failed agent, not a crash', async () => {
    const sink: ResearchProgress[] = [];
    const run = harnessResearchAgent({ createChat: () => null, fs: fakeFs().fs, turnSink: () => (p) => sink.push(p) });
    const reply = await run({ prompt: 'x' }, ctx());
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/research agent failed: research agents are not available/);
    expect(sink.at(-1)).toMatchObject({ type: 'subagent_finished', outcome: 'failed' });
  });

  it('stops when the caller cancels the call (notifications/cancelled, a revoked token)', async () => {
    const stop = new AbortController();
    const sink: ResearchProgress[] = [];
    const run = harnessResearchAgent({
      createChat: () => ({
        sendMessage: async () => { stop.abort(); return toolsTurn([['grep', { pattern: 'x' }]]); },
        sendToolResults: async () => textTurn('partial'),
      }),
      fs: fakeFs().fs,
      turnSink: () => (p) => sink.push(p),
    });
    const reply = await run({ prompt: 'x' }, ctx(stop.signal));
    expect(reply.isError).toBe(true);
    expect(sink.at(-1)).toMatchObject({ type: 'subagent_finished', outcome: 'stopped' });
  });

  it('runs at most three agents at once across separate calls; the rest wait, none is refused', async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = harnessResearchAgent({
      createChat: () => ({
        sendMessage: async () => { running++; peak = Math.max(peak, running); await gate; running--; return textTurn('d'); },
        sendToolResults: async () => textTurn('d'),
      }),
      fs: fakeFs().fs,
      turnSink: () => () => {},
    });
    const calls = Array.from({ length: 5 }, () => run({ prompt: 'q' }, ctx()));
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(3);
    release();
    const replies = await Promise.all(calls);
    expect(peak).toBe(3);
    expect(replies.every((r) => r.text === 'd' && !r.isError)).toBe(true);
  });

  it('a waiting call cancelled before its slot frees runs nothing', async () => {
    let built = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = harnessResearchAgent({
      createChat: () => { built++; return { sendMessage: async () => { await gate; return textTurn('d'); }, sendToolResults: async () => textTurn('d') }; },
      fs: fakeFs().fs,
      turnSink: () => () => {},
      maxConcurrent: 1,
    });
    const first = run({ prompt: 'a' }, ctx());
    const stop = new AbortController();
    const second = run({ prompt: 'b' }, ctx(stop.signal));
    stop.abort();
    expect(await second).toMatchObject({ isError: true });
    release();
    await first;
    expect(built).toBe(1);
  });

  it('is reached through the MCP tool on the wrapped handler; the handler\'s own tools are untouched', async () => {
    const base: PlannerToolHandler = { submitPlan: async () => ({ text: 'plan' }) } as PlannerToolHandler;
    const run = harnessResearchAgent({ createChat: () => scripted([textTurn('digest')]).chat, fs: fakeFs().fs, turnSink: () => () => {} });
    const wrapped = withResearchAgent(base, run);
    expect(await PLANNER_RESEARCH_AGENT.call(wrapped, { prompt: 'map it' }, ctx())).toEqual({ text: 'digest' });
    expect(wrapped.submitPlan).toBe(base.submitPlan);
    expect((await PLANNER_RESEARCH_AGENT.call(base, { prompt: 'x' }, ctx())).isError).toBe(true);
    expect((await PLANNER_RESEARCH_AGENT.call(wrapped, { prompt: '  ' }, ctx())).isError).toBe(true);
  });

  it('offers the agent only its confined tools and tells it so', () => {
    expect(toOpenAiSubagentTools(CONFINED_RESEARCH_TOOLS).map((t) => (t as { function: { name: string } }).function.name).sort())
      .toEqual([...CONFINED_RESEARCH_TOOLS].sort());
    expect(toOpenAiSubagentTools().length).toBeGreaterThan(CONFINED_RESEARCH_TOOLS.size);
    expect(buildSubagentSystemPrompt(true)).toMatch(/no shell, no web/);
    expect(buildSubagentSystemPrompt(false)).not.toMatch(/no shell, no web/);
  });

  it('names the agent in an OpenCode planner\'s prompt only when the session serves it', () => {
    expect(inTurnAgents(true, 'opencode')).toBeNull();
    expect(inTurnAgents(true, 'opencode', true, true)).toBe('spawn_research_agent');
    expect(inTurnAgents(true, 'opencode', false, true)).toBeNull();
    expect(inTurnAgents(true, 'claude-code', true, true)).toBe('your Agent tool');
  });
});
