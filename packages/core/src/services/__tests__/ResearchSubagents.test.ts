import { describe, it, expect, vi } from 'vitest';
import type { ResearchChat, ResearchTurn, ToolResult } from '../BaseAiService';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { runResearchAgent, mapWithConcurrency, SUBAGENT_LIMITS } from '../ResearchSubagents';
import type { UsageRecord } from '../../models/Usage';

function textTurn(text: string): ResearchTurn {
  return { text, toolCalls: [], hasToolCalls: false };
}

function toolTurn(name: string, args: Record<string, unknown>, id = 't1'): ResearchTurn {
  return { text: '', toolCalls: [{ name, args, id }], hasToolCalls: true };
}

/** Pops one turn per call; repeats the last turn if the script runs out. */
function scriptedChat(turns: ResearchTurn[]): ResearchChat & { received: ToolResult[][]; prompts: string[] } {
  let i = 0;
  const next = () => turns[Math.min(i++, turns.length - 1)];
  const chat = {
    received: [] as ToolResult[][],
    prompts: [] as string[],
    sendMessage: async (text: string) => {
      chat.prompts.push(text);
      return next();
    },
    sendToolResults: async (results: ToolResult[]) => {
      chat.received.push(results);
      return next();
    },
  };
  return chat;
}

/** Read-only fs fake that records every method touched. */
function fakeFs(): { fs: IFileSystem; touched: string[] } {
  const touched: string[] = [];
  const ok = (name: string) => async (..._args: unknown[]) => {
    touched.push(name);
    return { success: true, output: `${name} output`, truncated: false };
  };
  const fs: IFileSystem = {
    readFile: ok('readFile'),
    readFiles: ok('readFiles'),
    glob: ok('glob'),
    grep: ok('grep'),
    findSymbol: ok('findSymbol'),
    listDir: ok('listDir'),
    bash: ok('plannerBash'),
    // Which commands a subagent may run is the command gate's to say, and
    // BaseFileSystem.test.ts's: this loop only has to hand them over.
    subagentBash: ok('bash'),
    getWorkspaceRoot: () => '/ws',
  };
  return { fs, touched };
}

describe('runResearchAgent', () => {
  it('announces the subagent starting, then finishing with its digest and usage', async () => {
    const chat = scriptedChat([textTurn('the digest')]);
    const { fs } = fakeFs();
    const events: unknown[] = [];

    await runResearchAgent('map packages/core', {
      createChat: () => chat,
      fs,
      subagentId: 'sa1',
      model: 'flash',
      usage: () => ({ inputTokens: 900, outputTokens: 40 }),
      onProgress: (p) => events.push(p),
    });

    expect(events).toEqual([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'map packages/core', model: 'flash' },
      { type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'the digest', usage: { inputTokens: 900, outputTokens: 40 } },
    ]);
  });

  it('finishes a crashed subagent with the failed outcome', async () => {
    const bad: ResearchChat = {
      sendMessage: async () => { throw new Error('provider exploded'); },
      sendToolResults: async () => { throw new Error('unreachable'); },
    };
    const { fs } = fakeFs();
    const events: unknown[] = [];

    await runResearchAgent('brief', { createChat: () => bad, fs, subagentId: 'sa1', onProgress: (p) => events.push(p) });

    expect(events).toEqual([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'brief', model: undefined },
      expect.objectContaining({ type: 'subagent_finished', subagentId: 'sa1', outcome: 'failed', digest: expect.stringContaining('provider exploded') }),
    ]);
  });

  it('finishes an aborted subagent with the stopped outcome', async () => {
    const ac = new AbortController();
    ac.abort();
    const chat = scriptedChat([toolTurn('glob', { pattern: '*' }), textTurn('never')]);
    const { fs } = fakeFs();
    const events: unknown[] = [];

    await runResearchAgent('brief', { createChat: () => chat, fs, signal: ac.signal, subagentId: 'sa1', onProgress: (p) => events.push(p) });

    expect(events).toEqual([
      { type: 'subagent_started', subagentId: 'sa1', brief: 'brief', model: undefined },
      expect.objectContaining({ type: 'subagent_finished', subagentId: 'sa1', outcome: 'stopped' }),
    ]);
  });

  it('interleaves two concurrent subagents but keeps each one started → steps → finished', async () => {
    const { fs } = fakeFs();
    const events: import('../../models/Task').ResearchProgress[] = [];
    // Each chat pauses, so the two loops interleave at the event boundary
    // rather than running to completion one after the other.
    const delayedChat = (id: string): ResearchChat => {
      let toolDone = false;
      return {
        sendMessage: async () => {
          await new Promise((r) => setTimeout(r, id === 'sa-a' ? 1 : 3));
          if (!toolDone) { toolDone = true; return toolTurn('glob', { pattern: '*' }, `${id}-t1`); }
          return textTurn(`digest ${id}`);
        },
        sendToolResults: async () => textTurn(`digest ${id}`),
      };
    };

    await mapWithConcurrency(['sa-a', 'sa-b'], 2, (id) =>
      runResearchAgent(`brief ${id}`, { createChat: () => delayedChat(id), fs, subagentId: id, onProgress: (p) => events.push(p) }));

    const forA = events.filter((e) => e.subagentId === 'sa-a');
    const forB = events.filter((e) => e.subagentId === 'sa-b');
    // Both started before either finished — the streams really did overlap.
    expect(events.slice(0, 2).map((e) => e.type)).toEqual(['subagent_started', 'subagent_started']);
    for (const [id, own] of [['sa-a', forA], ['sa-b', forB]] as const) {
      expect(own[0]).toMatchObject({ type: 'subagent_started', subagentId: id, brief: `brief ${id}` });
      expect(own.at(-1)).toMatchObject({ type: 'subagent_finished', subagentId: id, outcome: 'done' });
      const inner = own.slice(1, -1);
      expect(inner.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
      expect(inner.every((e) => e.subagentId === id)).toBe(true);
    }

    const stepIds = events.filter((e) => e.type === 'tool_result' && e.step).map((e) => e.step!.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  it('sends the prompt to a fresh chat and returns its digest', async () => {
    const chat = scriptedChat([textTurn('the digest')]);
    const createChat = vi.fn(() => chat);
    const { fs } = fakeFs();

    const result = await runResearchAgent('map packages/core', { createChat, fs });

    expect(result.success).toBe(true);
    expect(result.output).toBe('the digest');
    expect(createChat).toHaveBeenCalledTimes(1);
    expect(chat.prompts).toEqual(['map packages/core']);
  });

  it('executes read-only tool calls and feeds results back until the digest arrives', async () => {
    const chat = scriptedChat([
      toolTurn('read_file', { path: 'src/a.ts' }),
      toolTurn('grep', { pattern: 'foo' }, 't2'),
      textTurn('the digest'),
    ]);
    const { fs, touched } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toEqual(['readFile', 'grep']);
    expect(chat.received[0][0].output).toContain('readFile output');
    expect(chat.received[0][0].id).toBe('t1');
    expect(result.output).toContain('the digest');
  });

  it('reports each inner tool call as a structured tool_call/tool_result progress pair', async () => {
    const chat = scriptedChat([
      toolTurn('read_file', { path: 'src/a.ts' }),
      textTurn('the digest'),
    ]);
    const { fs } = fakeFs();
    const events: unknown[] = [];

    await runResearchAgent('brief', { createChat: () => chat, fs, onProgress: (p) => events.push(p) });

    // The lifecycle events are covered separately; this test is about the
    // tool_call/tool_result pair the inner loop reports.
    expect(events.filter((e) => (e as { type: string }).type === 'tool_call' || (e as { type: string }).type === 'tool_result')).toEqual([
      { type: 'tool_call', tool: 'read_file', toolArgs: JSON.stringify({ path: 'src/a.ts' }), toolCallId: 't1' },
      {
        type: 'tool_result',
        toolResult: 'readFile output',
        toolCallId: 't1',
        step: expect.objectContaining({
          tool: 'read_file',
          args: JSON.stringify({ path: 'src/a.ts' }),
          result: 'readFile output',
          success: true,
          outcome: 'success',
          toolCallId: 't1',
        }),
      },
    ]);
  });

  it('wires a reasoning callback into createChat and surfaces its deltas as thinking progress', async () => {
    const chat = scriptedChat([textTurn('the digest')]);
    const { fs } = fakeFs();
    const events: unknown[] = [];
    let reasoningFn: ((delta: string) => void) | undefined;
    const createChat = (onReasoning: (delta: string) => void) => { reasoningFn = onReasoning; return chat; };

    await runResearchAgent('brief', { createChat, fs, onProgress: (p) => events.push(p) });

    expect(reasoningFn).toBeTypeOf('function');
    reasoningFn!('Considering the auth flow…');
    expect(events.filter((e) => (e as { type: string }).type === 'thinking')).toEqual([{ type: 'thinking', text: 'Considering the auth flow…' }]);
  });

  it('files each call the chat reports under the subagent that made it (#49)', async () => {
    const chat = scriptedChat([toolTurn('read_file', { path: 'src/a.ts' }), textTurn('digest')]);
    const { fs } = fakeFs();
    const events: import('../../models/Task').ResearchProgress[] = [];
    const createChat = (_onReasoning: unknown, onUsage: (record: UsageRecord) => void) => ({
      sendMessage: async (text: string) => { onUsage({ source: 'openai', model: 'gpt-4o', inputTokens: 100 }); return chat.sendMessage(text); },
      sendToolResults: async (results: ToolResult[]) => { onUsage({ source: 'openai', model: 'gpt-4o', inputTokens: 50 }); return chat.sendToolResults(results); },
    });

    await runResearchAgent('brief', { createChat, fs, subagentId: 'sa1', onProgress: (p) => events.push(p) });

    expect(events.filter((p) => p.type === 'usage').map((p) => p.record)).toEqual([
      { source: 'openai', model: 'gpt-4o', inputTokens: 100, subagentId: 'sa1' },
      { source: 'openai', model: 'gpt-4o', inputTokens: 50, subagentId: 'sa1' },
    ]);
  });

  it('does not report progress for refused tool calls', async () => {
    const chat = scriptedChat([
      { text: '', hasToolCalls: true, toolCalls: [{ name: 'write_file', args: { path: 'a.ts' }, id: 'w1' }] },
      textTurn('digest'),
    ]);
    const { fs } = fakeFs();
    const events: unknown[] = [];

    await runResearchAgent('brief', { createChat: () => chat, fs, onProgress: (p) => events.push(p) });

    expect(events.filter((e) => (e as { type: string }).type === 'tool_call' || (e as { type: string }).type === 'tool_result')).toEqual([]);
  });

  it('refuses recursive spawn and hallucinated write tools without touching the filesystem', async () => {
    const chat = scriptedChat([
      {
        text: '',
        hasToolCalls: true,
        toolCalls: [
          { name: 'spawn_research_agent', args: { prompt: 'nested' }, id: 's1' },
          { name: 'write_file', args: { path: 'a.ts', content: 'x' }, id: 'w1' },
        ],
      },
      textTurn('digest after refusals'),
    ]);
    const { fs, touched } = fakeFs();
    const createChat = vi.fn(() => chat);

    const result = await runResearchAgent('brief', { createChat, fs });

    expect(touched).toEqual([]);
    expect(createChat).toHaveBeenCalledTimes(1); // no recursive spawn
    // Every refused call still gets a result keyed by its id — API history stays valid.
    expect(chat.received[0].map((r) => r.id)).toEqual(['s1', 'w1']);
    for (const r of chat.received[0]) {
      expect(r.output).toMatch(/read-only research subagent/i);
    }
    // T6: a refused capability must tell the subagent to report the gap in its
    // digest so the planner can request it directly — otherwise the gap is
    // silently dropped.
    expect(chat.received[0].find((r) => r.id === 'w1')!.output).toMatch(/digest/i);
    expect(result.output).toContain('digest after refusals');
  });

  // The network tools are now part of the subagent's set, but they run behind
  // the non-prompting fetcher the caller hands in — never the planner's own.
  it('dispatches fetch and web_search through the provided fetcher', async () => {
    const chat = scriptedChat([
      {
        text: '',
        hasToolCalls: true,
        toolCalls: [
          { name: 'fetch', args: { url: 'https://docs.example.com/x' }, id: 'f1' },
          { name: 'web_search', args: { query: 'hono routing' }, id: 'q1' },
        ],
      },
      textTurn('digest'),
    ]);
    const { fs } = fakeFs();
    const fetcher = {
      decide: vi.fn(),
      fetch: vi.fn().mockResolvedValue({ success: true, output: 'page body', truncated: false }),
      search: vi.fn().mockResolvedValue({ success: true, output: '1. Hono', truncated: false }),
    };

    await runResearchAgent('brief', { createChat: () => chat, fs, fetcher });

    expect(fetcher.fetch).toHaveBeenCalledWith('https://docs.example.com/x');
    expect(fetcher.search).toHaveBeenCalledWith('hono routing');
  });

  // T6: a subagent can never prompt, so the filesystem judges its commands
  // and this loop never runs one by any other route.
  it("runs a subagent's command through the filesystem's subagent shell, never its planner's", async () => {
    const chat = scriptedChat([
      toolTurn('bash', { command: 'git log -1' }),
      textTurn('digest'),
    ]);
    const { fs, touched } = fakeFs();

    await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toEqual(['bash']);
    expect(chat.received[0][0].output).toBe('bash output');
  });

  it('refuses every command where the filesystem cannot judge one for a subagent, and points it at its digest', async () => {
    const chat = scriptedChat([
      toolTurn('bash', { command: 'git log -1' }),
      textTurn('digest'),
    ]);
    const { fs, touched } = fakeFs();
    delete fs.subagentBash;

    await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toEqual([]);
    expect(chat.received[0][0].output).toMatch(/cannot judge a command for a research agent/);
    expect(chat.received[0][0].output).toMatch(/digest/i);
  });

  it('a chat failure returns a failed outcome instead of throwing', async () => {
    const bad: ResearchChat = {
      sendMessage: async () => { throw new Error('provider exploded'); },
      sendToolResults: async () => { throw new Error('unreachable'); },
    };
    const { fs } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => bad, fs });

    expect(result.success).toBe(false);
    expect(result.output).toContain('provider exploded');
    expect(result.output).toMatch(/continue researching/i);
  });

  it('stops at the step cap, nudges once for a wrap-up digest without executing further tools', async () => {
    const turns: ResearchTurn[] = Array.from({ length: SUBAGENT_LIMITS.maxSteps + 1 }, (_, i) => toolTurn('glob', { pattern: '*' }, `t${i}`));
    turns.push(textTurn('late digest'));
    const chat = scriptedChat(turns);
    const { fs, touched } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toHaveLength(SUBAGENT_LIMITS.maxSteps);
    const wrapUp = chat.received[chat.received.length - 1];
    expect(wrapUp[0].output).toMatch(/budget.*digest/is);
    expect(result.output).toContain('late digest');
  });

  it('marks a budget-cut digest partial and names exactly what the last round left unread', async () => {
    const turns: ResearchTurn[] = Array.from({ length: SUBAGENT_LIMITS.maxSteps }, (_, i) => toolTurn('glob', { pattern: '*' }, `t${i}`));
    turns.push(toolTurn('read_file', { path: 'packages/core/src/unread.ts' }, 'last'));
    turns.push(textTurn('found: a.ts holds x'));
    const { fs } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => scriptedChat(turns), fs });

    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^\[PARTIAL/);
    expect(result.output).toContain('found: a.ts holds x');
    expect(result.output).toMatch(/Left unread:[\s\S]*read_file[\s\S]*packages\/core\/src\/unread\.ts/);
  });

  it('still names the unread when the partial digest itself overflows the cap', async () => {
    const turns: ResearchTurn[] = Array.from({ length: SUBAGENT_LIMITS.maxSteps }, (_, i) => toolTurn('glob', { pattern: '*' }, `t${i}`));
    turns.push(toolTurn('read_file', { path: 'only/here.ts' }, 'last'));
    turns.push(textTurn('y'.repeat(SUBAGENT_LIMITS.digestMaxChars * 2)));
    const { fs } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => scriptedChat(turns), fs });

    expect(result.output).toContain('only/here.ts');
    expect(result.output.length).toBeLessThan(SUBAGENT_LIMITS.digestMaxChars + 1000);
  });

  it('shares one budget between both agents: 24 steps and a 12,000-character digest (ADR-0066)', () => {
    expect(SUBAGENT_LIMITS.maxSteps).toBe(24);
    expect(SUBAGENT_LIMITS.digestMaxChars).toBe(12000);
  });

  it('keeps the end of an oversized partial digest, where the agent lists what it did not cover', async () => {
    const turns: ResearchTurn[] = Array.from({ length: SUBAGENT_LIMITS.maxSteps }, (_, i) => toolTurn('glob', { pattern: '*' }, `t${i}`));
    turns.push(toolTurn('read_file', { path: 'only/here.ts' }, 'last'));
    turns.push(textTurn(`HEAD-MARK ${'y'.repeat(SUBAGENT_LIMITS.digestMaxChars * 2)} ## Not covered: packages/cli/src/sea.ts`));
    const { fs } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => scriptedChat(turns), fs });

    expect(result.output).toContain('HEAD-MARK');
    expect(result.output).toContain('Not covered: packages/cli/src/sea.ts');
    expect(result.output.length).toBeLessThanOrEqual(SUBAGENT_LIMITS.digestMaxChars);
  });

  it('asks the cut-off agent to end its digest with the areas it did not cover', async () => {
    const turns: ResearchTurn[] = Array.from({ length: SUBAGENT_LIMITS.maxSteps + 1 }, (_, i) => toolTurn('glob', { pattern: '*' }, `t${i}`));
    turns.push(textTurn('late digest'));
    const chat = scriptedChat(turns);
    const { fs } = fakeFs();

    await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(chat.received[chat.received.length - 1][0].output).toMatch(/not covered/i);
  });

  it('truncates oversized digests to the cap', async () => {
    const chat = scriptedChat([textTurn('x'.repeat(SUBAGENT_LIMITS.digestMaxChars + 500))]);
    const { fs } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(result.output.length).toBeLessThan(SUBAGENT_LIMITS.digestMaxChars + 300);
    expect(result.output).toContain('truncated');
  });

  it('an aborted signal stops the loop without executing tools', async () => {
    const ac = new AbortController();
    ac.abort();
    const chat = scriptedChat([toolTurn('glob', { pattern: '*' }), textTurn('never')]);
    const { fs, touched } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => chat, fs, signal: ac.signal });

    expect(touched).toEqual([]);
    expect(result.output).toMatch(/abort/i);
  });

  // The between-rounds check is not enough: a subagent's round can hold half a
  // dozen calls, and stopping the planner must not wait for all of them.
  it('stops part-way through a round rather than finishing every call in it', async () => {
    const ac = new AbortController();
    const { fs, touched } = fakeFs();
    const stopOnFirst = fs.subagentBash!;
    fs.subagentBash = async (command: string) => {
      ac.abort();
      return stopOnFirst(command);
    };
    const chat = scriptedChat([
      {
        text: '',
        toolCalls: [
          { name: 'bash', args: { command: 'ls' }, id: 't1' },
          { name: 'glob', args: { pattern: '*' }, id: 't2' },
        ],
        hasToolCalls: true,
      },
      textTurn('digest'),
    ]);

    await runResearchAgent('brief', { createChat: () => chat, fs, signal: ac.signal });

    expect(touched).toEqual(['bash']);
  });

  it('hands the signal to bash so a long command can be killed rather than waited out', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const { fs } = fakeFs();
    fs.subagentBash = (_command: string, signal?: AbortSignal) => new Promise((resolve) => {
      seen = signal;
      signal?.addEventListener('abort', () => resolve({ success: false, output: 'stopped', truncated: false }));
    });
    const chat = scriptedChat([toolTurn('bash', { command: 'find . -name "*.ts"' }), textTurn('digest')]);

    const running = runResearchAgent('brief', { createChat: () => chat, fs, signal: ac.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    ac.abort();
    await running;

    expect(seen!.aborted).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('runs at most `limit` items in flight and preserves input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5];

    const results = await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(maxInFlight).toBe(3);
  });
});
