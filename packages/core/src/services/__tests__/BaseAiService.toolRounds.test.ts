import { describe, it, expect, vi } from 'vitest';
import { BaseAiService, type ResearchChat, type ResearchTurn, type ToolResult, type ConversationTurnContext, type ToolCall } from '../BaseAiService';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';

/**
 * These exercise one tool round through the real loop: what the loop does with
 * a turn carrying several tool calls, observed through the filesystem it drives
 * and the results it feeds back — not through its internals.
 */

class ScriptedChat implements ResearchChat {
  toolResultsSent: ToolResult[][] = [];
  constructor(private turns: ResearchTurn[]) {}
  async sendMessage(): Promise<ResearchTurn> {
    const next = this.turns.shift();
    if (!next) throw new Error('ScriptedChat exhausted');
    return next;
  }
  async sendToolResults(results: ToolResult[]): Promise<ResearchTurn> {
    this.toolResultsSent.push(results);
    const next = this.turns.shift();
    if (!next) throw new Error('ScriptedChat exhausted');
    return next;
  }
}

class TestService extends BaseAiService {
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(): Promise<string> { return ''; }
  runTurn(ctx: ConversationTurnContext, onProgress: (p: ResearchProgress) => void = () => {}, signal?: AbortSignal) {
    return this.runConversationTurn(ctx, 'go', onProgress, signal);
  }
}

const toolTurn = (toolCalls: ToolCall[]): ResearchTurn => ({ text: '', toolCalls, hasToolCalls: true });
const proseTurn = (text: string): ResearchTurn => ({ text, toolCalls: [], hasToolCalls: false });

/** Records overlap: how many calls were in flight at the same moment. */
function concurrencyTracker() {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const gate = async <T>(label: string, value: T): Promise<T> => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    order.push(label);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return value;
  };
  return { gate, peak: () => peak, order };
}

function ctxFor(chat: ResearchChat, fs: IFileSystem): ConversationTurnContext {
  return { chat, fs, runners: ['claude-code'] };
}

describe('tool rounds — read-only calls share a round', () => {
  it('runs several reads concurrently instead of one after another', async () => {
    const tracker = concurrencyTracker();
    const fs = fakeFileSystem({
      readFile: (p) => tracker.gate(`read:${p}`, { success: true, output: `body of ${p}`, truncated: false }),
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'read_file', args: { path: 'a.ts' }, id: '1' },
        { name: 'read_file', args: { path: 'b.ts' }, id: '2' },
        { name: 'read_file', args: { path: 'c.ts' }, id: '3' },
      ]),
      proseTurn('done'),
    ]);

    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs));

    expect(tracker.peak()).toBe(3);
  });

  it('feeds results back in call order even though they finish out of order', async () => {
    const delays: Record<string, number> = { 'a.ts': 30, 'b.ts': 1, 'c.ts': 15 };
    const fs = fakeFileSystem({
      readFile: async (p) => {
        await new Promise((r) => setTimeout(r, delays[p] ?? 0));
        return { success: true, output: `body of ${p}`, truncated: false };
      },
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'read_file', args: { path: 'a.ts' }, id: '1' },
        { name: 'read_file', args: { path: 'b.ts' }, id: '2' },
        { name: 'read_file', args: { path: 'c.ts' }, id: '3' },
      ]),
      proseTurn('done'),
    ]);

    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs));

    const outputs = chat.toolResultsSent[0].map((r) => r.output);
    expect(outputs).toEqual(['body of a.ts', 'body of b.ts', 'body of c.ts']);
    expect(chat.toolResultsSent[0].map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('mixes tool kinds in one round and still answers every call exactly once', async () => {
    const fs = fakeFileSystem({
      readFile: async () => ({ success: true, output: 'file', truncated: false }),
      grep: async () => ({ success: true, output: 'hit', truncated: false }),
      findSymbol: async () => ({ success: true, output: 'def', truncated: false }),
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'grep', args: { pattern: 'TODO' }, id: '1' },
        { name: 'read_file', args: { path: 'a.ts' }, id: '2' },
        { name: 'find_symbol', args: { symbol: 'Foo' }, id: '3' },
      ]),
      proseTurn('done'),
    ]);

    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs));

    expect(chat.toolResultsSent[0].map((r) => r.output)).toEqual(['hit', 'file', 'def']);
  });
});

describe('tool rounds — approval-capable calls stay serial', () => {
  it('never overlaps bash calls, so a round cannot raise two prompts at once', async () => {
    const tracker = concurrencyTracker();
    const fs = fakeFileSystem({
      bash: (cmd) => tracker.gate(`bash:${cmd}`, { success: true, output: 'ok', truncated: false }),
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'bash', args: { command: 'npm test' }, id: '1' },
        { name: 'bash', args: { command: 'az group list' }, id: '2' },
      ]),
      proseTurn('done'),
    ]);

    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs));

    expect(tracker.peak()).toBe(1);
  });

  it('does not let a parallel read overlap a bash call in the same round', async () => {
    const tracker = concurrencyTracker();
    const fs = fakeFileSystem({
      readFile: () => tracker.gate('read', { success: true, output: 'file', truncated: false }),
      bash: () => tracker.gate('bash', { success: true, output: 'ok', truncated: false }),
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'read_file', args: { path: 'a.ts' }, id: '1' },
        { name: 'bash', args: { command: 'npm test' }, id: '2' },
      ]),
      proseTurn('done'),
    ]);

    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs));

    expect(tracker.peak()).toBe(1);
  });
});

describe('tool rounds — progress reporting', () => {
  it('announces every call and every result, whichever pass ran it', async () => {
    const fs = fakeFileSystem({
      readFile: async () => ({ success: true, output: 'file', truncated: false }),
      bash: async () => ({ success: true, output: 'ok', truncated: false }),
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'read_file', args: { path: 'a.ts' }, id: '1' },
        { name: 'read_file', args: { path: 'b.ts' }, id: '2' },
        { name: 'bash', args: { command: 'git log' }, id: '3' },
      ]),
      proseTurn('done'),
    ]);

    const events: ResearchProgress[] = [];
    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs), (p) => events.push(p));

    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3);
  });
});

/**
 * Stopping the planner has to reach the tool call itself. Noticing the abort
 * only between rounds meant a `sleep 600` or a wide subagent sweep ran to
 * completion after the user pressed stop, and the loop carried on from there.
 */
describe('tool rounds — an abort reaches the call in flight', () => {
  it('hands the signal to a long-running bash so the child can be killed', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fs = fakeFileSystem({
      bash: (_cmd, signal) => new Promise((resolve) => {
        seen = signal;
        signal?.addEventListener('abort', () =>
          resolve({ success: false, output: 'Command stopped.', truncated: false }));
      }),
    });
    const chat = new ScriptedChat([
      toolTurn([{ name: 'bash', args: { command: 'sleep 600' }, id: '1' }]),
      proseTurn('stopped'),
    ]);

    const running = new TestService(fakeConfig()).runTurn(ctxFor(chat, fs), () => {}, controller.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();

    expect((await running).kind).toBe('message');
    expect(seen!.aborted).toBe(true);
  });

  it('does not start the rest of a round once the abort has landed', async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const fs = fakeFileSystem({
      bash: async (cmd) => {
        ran.push(cmd);
        controller.abort();
        return { success: true, output: 'ok', truncated: false };
      },
    });
    const chat = new ScriptedChat([
      toolTurn([
        { name: 'bash', args: { command: 'first' }, id: '1' },
        { name: 'bash', args: { command: 'second' }, id: '2' },
      ]),
      proseTurn('stopped'),
    ]);

    await new TestService(fakeConfig()).runTurn(ctxFor(chat, fs), () => {}, controller.signal);

    expect(ran).toEqual(['first']);
    // The skipped call still gets an answer: a dangling tool_call would make
    // the API history invalid for whatever the user does next.
    const [first, second] = chat.toolResultsSent[0];
    expect(first.output).toBe('ok');
    expect(second.output).toMatch(/stopped/i);
  });
});
