import { describe, it, expect, vi } from 'vitest';
import type { ResearchChat, ResearchTurn, ToolResult } from '../BaseAiService';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { runResearchAgent, mapWithConcurrency, SUBAGENT_LIMITS } from '../ResearchSubagents';

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
    bash: ok('bash'),
    getWorkspaceRoot: () => '/ws',
  };
  return { fs, touched };
}

describe('runResearchAgent', () => {
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

    expect(events).toEqual([
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
    expect(events).toEqual([{ type: 'thinking', text: 'Considering the auth flow…' }]);
  });

  it('does not report progress for refused tool calls', async () => {
    const chat = scriptedChat([
      { text: '', hasToolCalls: true, toolCalls: [{ name: 'fetch', args: { url: 'https://x.test' }, id: 'f1' }] },
      textTurn('digest'),
    ]);
    const { fs } = fakeFs();
    const events: unknown[] = [];

    await runResearchAgent('brief', { createChat: () => chat, fs, onProgress: (p) => events.push(p) });

    expect(events).toEqual([]);
  });

  it('refuses fetch, recursive spawn, and hallucinated write tools without touching the filesystem', async () => {
    const chat = scriptedChat([
      {
        text: '',
        hasToolCalls: true,
        toolCalls: [
          { name: 'fetch', args: { url: 'https://x.test' }, id: 'f1' },
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
    expect(chat.received[0].map((r) => r.id)).toEqual(['f1', 's1', 'w1']);
    for (const r of chat.received[0]) {
      expect(r.output).toMatch(/read-only research subagent/i);
    }
    // T6: a refused capability must tell the subagent to report the gap in its
    // digest so the planner can request it directly — otherwise the gap is
    // silently dropped.
    expect(chat.received[0].find((r) => r.id === 'f1')!.output).toMatch(/digest/i);
    expect(result.output).toContain('digest after refusals');
  });

  // T6: an ask-tier bash command from a subagent is refused (subagents can
  // never prompt) with a message pointing the agent at its digest.
  it('refuses an ask-tier bash command and points the subagent at its digest', async () => {
    const chat = scriptedChat([
      toolTurn('bash', { command: 'npm test' }),
      textTurn('digest'),
    ]);
    const { fs, touched } = fakeFs();

    await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toEqual([]);
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
    const turns: ResearchTurn[] = Array.from({ length: 11 }, (_, i) => toolTurn('glob', { pattern: '*' }, `t${i}`));
    turns.push(textTurn('late digest'));
    const chat = scriptedChat(turns);
    const { fs, touched } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toHaveLength(SUBAGENT_LIMITS.maxSteps);
    const wrapUp = chat.received[chat.received.length - 1];
    expect(wrapUp[0].output).toMatch(/budget.*digest/is);
    expect(result.output).toContain('late digest');
  });

  it('truncates oversized digests to the cap', async () => {
    const chat = scriptedChat([textTurn('x'.repeat(SUBAGENT_LIMITS.digestMaxChars + 500))]);
    const { fs } = fakeFs();

    const result = await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(result.output.length).toBeLessThan(SUBAGENT_LIMITS.digestMaxChars + 300);
    expect(result.output).toContain('truncated');
  });

  it('refuses an auto-tier bash command whose argument names a path outside the workspace', async () => {
    // cat/find/rg/etc. are auto-tier by binary alone; a subagent can never
    // prompt for approval, so an escaping path must be refused outright
    // rather than silently forwarded to the real bash.
    const chat = scriptedChat([
      toolTurn('bash', { command: 'cat /etc/passwd' }),
      textTurn('digest'),
    ]);
    const { fs, touched } = fakeFs();

    await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toEqual([]);
    expect(chat.received[0][0].output).toMatch(/outside the workspace/i);
  });

  it('still runs an auto-tier bash command whose argument stays inside the workspace', async () => {
    const chat = scriptedChat([
      toolTurn('bash', { command: 'cat src/a.ts' }),
      textTurn('digest'),
    ]);
    const { fs, touched } = fakeFs();

    await runResearchAgent('brief', { createChat: () => chat, fs });

    expect(touched).toEqual(['bash']);
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
