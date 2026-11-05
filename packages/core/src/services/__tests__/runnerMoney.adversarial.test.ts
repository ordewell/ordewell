import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { addAttemptUsage, startAttemptUsage, type AttemptUsage } from '../../models/Usage';
import { fakeSpawn, fixture } from './harnessTestKit';

/**
 * Adversarial: what every recorded Claude Code stream reports in its `result`
 * lines is what the attempt counts, once. A turn whose calls streamed reports
 * each call itself; one recorded without partial messages reports only the
 * turn's sum, which is taken once and never as a per-call context.
 */

interface Line {
  type?: string;
  subtype?: string;
  permissionMode?: string;
  session_id?: string;
  model?: string;
  total_cost_usd?: number;
  parent_tool_use_id?: string | null;
  usage?: Usage;
  message?: { id?: string; model?: string; usage?: Usage };
  tool_use_result?: { usage?: Usage };
  event?: { type?: string; usage?: Usage };
  modelUsage?: Record<string, { costUSD?: number; contextWindow?: number; costBasis?: string }>;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function processDeps(text: string | string[]): AgentProcessDeps {
  const spawned = fakeSpawn(Array.isArray(text) ? text : [text]);
  return {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
}

function linesOf(text: string): Line[] {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Line]; } catch { return []; }
  });
}

/** A call's prompt as the runner splits it: uncached input, cache write, cache read. */
function promptOf(usage: Usage | undefined): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
}

function expectedUsage(lines: Line[]): { input: number; cached: number; output: number } {
  // A result states its turn's own sum, whether or not the turn's calls
  // streamed. The attempt must equal it: streamed calls are counted once and a
  // call whose stream is missing (or absent, in an older recording) is added
  // from that remainder.
  const main = lines.flatMap((l) => (l.type === 'result' && l.usage ? [l.usage] : []));
  let input = main.reduce((sum, u) => sum + promptOf(u), 0);
  let cached = main.reduce((sum, u) => sum + (u.cache_read_input_tokens ?? 0), 0);
  let output = main.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0);
  // A subagent's assistant lines are prompt snapshots (no output yet); its last
  // call arrives whole on the Agent result.
  const counted = new Set<string>();
  for (const l of lines) {
    if (l.type !== 'assistant' || !l.parent_tool_use_id) continue;
    const id = l.message?.id;
    if (id && counted.has(id)) continue;
    if (id) counted.add(id);
    input += promptOf(l.message?.usage);
    cached += l.message?.usage?.cache_read_input_tokens ?? 0;
  }
  for (const l of lines) {
    const usage = l.type === 'user' ? l.tool_use_result?.usage : undefined;
    if (!usage) continue;
    input += promptOf(usage);
    cached += usage.cache_read_input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
  }
  return { input, cached, output };
}

function tokensOf(ledger: AttemptUsage): { input: number; cached: number; output: number } {
  const { inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 } = ledger.totals;
  return { input: inputTokens, cached: cachedInputTokens, output: outputTokens };
}

function costOf(ledger: AttemptUsage): number {
  return ledger.totals.reportedCost?.USD ?? 0;
}

const REPLAYED = [
  'task-checkpoint', 'task-background', 'task-no-marker', 'task-marker', 'task-compact',
  'task-interrupt-followup', 'task-command-skill', 'task-model-switched', 'task-effort-command',
  'stream-tool-rounds', 'stream-subagent', 'stream-reasoning', 'stream-async-agent-report',
  'permission-task-allowed-for-task', 'permission-task-cancelled',
];

describe('adversarial: every recorded attempt counts what its result lines report', () => {
  it.each(REPLAYED)('%s', async (name) => {
    const text = fixture('claude-code', name);
    const lines = linesOf(text);
    const mode = lines.find((l) => l.type === 'system' && l.subtype === 'init')?.permissionMode ?? 'default';
    const start: TaskStartOptions = { kind: 'task', cwd: '/repo', mode, flags: { permissionMode: mode, modeSettings: {} } };
    const adapter = new ClaudeCodeAdapter(processDeps(text));
    await adapter.start(start);
    const events: AgentEvent[] = [];
    adapter.onOutOfTurn?.((event) => events.push(event));
    await adapter.send('do it', (event) => events.push(event));
    let ledger = startAttemptUsage(1, 'claude-code', '2026-10-19T00:00:00Z');
    for (const event of events) {
      if (event.type === 'usage') ledger = addAttemptUsage(ledger, event.record, '2026-10-19T00:01:00Z');
    }

    const results = lines.flatMap((l) => (l.type === 'result' && typeof l.total_cost_usd === 'number' ? [l.total_cost_usd] : []));
    expect(costOf(ledger)).toBeCloseTo(results.at(-1) ?? 0, 9);
    expect(tokensOf(ledger)).toEqual(expectedUsage(lines));
    adapter.dispose();
  });
});

/**
 * The per-model breakdown and the session total can be reported by different
 * results: an older CLI, or a resume whose kept count had no model split. A
 * result without a breakdown is counted as a total; once a breakdown appears,
 * only the growth over what was already counted is new, never the cumulative
 * per-model figure again.
 */
describe('adversarial: a total-only report and a per-model report count each dollar once', () => {
  const session = 'sess-mixed';
  const init = (): Line => ({ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5', permissionMode: 'default' });
  const totalOnly = (total: number): Line => ({ type: 'result', subtype: 'success', session_id: session, total_cost_usd: total, modelUsage: {} });
  const breakdown = (total: number): Line => ({
    type: 'result', subtype: 'success', session_id: session, total_cost_usd: total,
    modelUsage: { 'claude-opus-5': { costUSD: total, contextWindow: 200_000, costBasis: 'list' } },
  });
  const text = (...lines: Line[]): string => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;

  async function costsOf(replies: string[], opts: Partial<TaskStartOptions> = {}): Promise<{ costs: number[]; cost: ReturnType<ClaudeCodeAdapter['sessionCost']> }> {
    const adapter = new ClaudeCodeAdapter(processDeps(replies));
    await adapter.start({ kind: 'task', cwd: '/repo', mode: 'default', flags: { permissionMode: 'default', modeSettings: {} }, ...opts });
    const events: AgentEvent[] = [];
    for (let i = 0; i < replies.length; i += 1) await adapter.send(`turn ${i + 1}`, (event) => events.push(event));
    const costs = events.flatMap((event) => (event.type === 'usage' && event.record.reportedCost ? [event.record.reportedCost.amount] : []));
    const cost = adapter.sessionCost();
    adapter.dispose();
    return { costs, cost };
  }

  it('counts only the growth when the breakdown appears after a total-only result', async () => {
    const { costs, cost } = await costsOf([text(init(), totalOnly(2)), text(init(), breakdown(2.5))]);
    expect(costs).toEqual([2, 0.5]);
    expect(cost).toMatchObject({ usd: 2.5, modelUsd: { 'claude-opus-5': 2.5 } });
  });

  it('counts only the growth when a resume\'s kept count had no model split', async () => {
    const { costs } = await costsOf([text(init(), breakdown(2.5))], { resumeSessionId: session, resumeCost: { sessionId: session, usd: 2, modelUsd: {} } });
    expect(costs).toEqual([0.5]);
  });

  it('keeps counting per model when the kept count did have a split', async () => {
    const { costs } = await costsOf([text(init(), breakdown(2.5))], { resumeSessionId: session, resumeCost: { sessionId: session, usd: 2, modelUsd: { 'claude-opus-5': 2 } } });
    expect(costs).toEqual([0.5]);
  });

  it('counts no baseline turn of a resume that kept no count, even when the split appears later', async () => {
    const { costs, cost } = await costsOf([text(init(), totalOnly(2)), text(init(), breakdown(2.5))], { resumeSessionId: session });
    expect(costs).toEqual([0.5]);
    expect(cost).toMatchObject({ usd: 2.5 });
  });

  it('does not count counted dollars again when a resumed total comes back lower', async () => {
    // A process that dies before its session was saved can resume reporting
    // less than what it already told Ordewell it spent. That money was spent;
    // its return is not new spend.
    const { costs, cost } = await costsOf(
      [text(init(), breakdown(4)), text(init(), breakdown(5))],
      { resumeSessionId: session, resumeCost: { sessionId: session, usd: 5, modelUsd: { 'claude-opus-5': 5 } } },
    );
    expect(costs).toEqual([]);
    expect(cost).toMatchObject({ usd: 5 });
  });

  it('does not count counted dollars again when a lower total-only report is followed by another', async () => {
    const { costs, cost } = await costsOf(
      [text(init(), totalOnly(4)), text(init(), totalOnly(5))],
      { resumeSessionId: session, resumeCost: { sessionId: session, usd: 5, modelUsd: {} } },
    );
    expect(costs).toEqual([]);
    expect(cost).toMatchObject({ usd: 5 });
  });

  it('sets a resume\'s baseline from a first report that carries only its models', async () => {
    const noTotal = (cost: number): Line => ({
      type: 'result', subtype: 'success', session_id: session,
      modelUsage: { 'claude-opus-5': { costUSD: cost, costBasis: 'list' } },
    });
    const { costs, cost } = await costsOf(
      [text(init(), noTotal(2)), text(init(), breakdown(2.5))],
      { resumeSessionId: session },
    );
    expect(costs).toEqual([0.5]);
    expect(cost).toMatchObject({ usd: 2.5 });
  });

  it('counts a cost the runner marked unknown once it reports a basis, and only then', async () => {
    const unknown = (total: number): Line => ({
      type: 'result', subtype: 'success', session_id: session, total_cost_usd: total,
      modelUsage: { 'claude-opus-5': { costUSD: total, costBasis: 'unknown' } },
    });
    const { costs } = await costsOf([text(init(), unknown(5)), text(init(), breakdown(7))]);
    expect(costs).toEqual([7]);
  });
});
