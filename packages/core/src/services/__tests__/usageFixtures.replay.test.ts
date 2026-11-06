import { describe, expect, it } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions } from '../harness/AgentAdapter';
import { addAttemptUsage, plannerContextFill, startAttemptUsage, type PlannerUsage } from '../../models/Usage';
import { ContextWindowFill, SessionWindows } from '../ContextWindowFill';
import { PlannerUsageLedger } from '../PlannerUsage';
import { fakeSpawn, fixture } from './harnessTestKit';

/**
 * Every recorded Claude Code stream that reports a cost, replayed through the
 * ledger a task attempt keeps and the one the planner keeps: what each draws
 * must be what the runner itself reported. The cost is the session's last
 * `total_cost_usd`; the meter is what the main thread's last call left — its
 * whole prompt and its output, as Claude Code counts it — or the size its last
 * compaction left; the window is the one the last `result` states for that
 * model; and a login the runner names as a subscription marks the cost as an
 * API equivalent.
 */

interface Usage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }

interface Line {
  type?: string;
  subtype?: string;
  permissionMode?: string;
  model?: string;
  apiKeySource?: string;
  total_cost_usd?: number;
  parent_tool_use_id?: string | null;
  event?: { type?: string; usage?: Usage; message?: { model?: string } };
  compact_metadata?: { post_tokens?: number };
  modelUsage?: Record<string, { contextWindow?: number }>;
}

function linesOf(text: string): Line[] {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Line]; } catch { return []; }
  });
}

/** What the recording says, read straight from its lines. */
function reported(lines: Line[]): { cost: number; meter?: number; window?: number; subscription: boolean } {
  const main = lines.filter((l) => !l.parent_tool_use_id);
  let meter: number | undefined;
  let model: string | undefined;
  for (const l of main) {
    if (l.type === 'system' && l.subtype === 'init' && l.model) model = l.model;
    if (l.type === 'stream_event' && l.event?.type === 'message_start' && l.event.message?.model) model = l.event.message.model;
    if (l.type === 'stream_event' && l.event?.type === 'message_delta' && l.event.usage) {
      const u = l.event.usage;
      meter = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    if (l.type === 'system' && l.subtype === 'compact_boundary') meter = l.compact_metadata?.post_tokens;
  }
  const last = main.filter((l) => l.type === 'result').at(-1);
  return {
    cost: last?.total_cost_usd ?? 0,
    meter,
    window: meter !== undefined && model ? last?.modelUsage?.[model]?.contextWindow : undefined,
    subscription: lines.some((l) => l.apiKeySource === 'none'),
  };
}

async function replay(text: string, kind: 'task' | 'planner'): Promise<UsageRecordEvent[]> {
  const spawned = fakeSpawn([text]);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  const mode = linesOf(text).find((l) => l.type === 'system' && l.subtype === 'init')?.permissionMode ?? 'default';
  const start: AgentStartOptions = kind === 'task'
    ? { kind, cwd: '/repo', mode, flags: { permissionMode: mode, modeSettings: {} } }
    : { kind, cwd: '/repo', systemPrompt: 'plan read-only' };
  const adapter = new ClaudeCodeAdapter(deps);
  await adapter.start(start);
  const events: AgentEvent[] = [];
  adapter.onOutOfTurn?.((event) => events.push(event));
  await adapter.send('do it', (event) => events.push(event));
  adapter.dispose();
  return events.filter((e): e is UsageRecordEvent => e.type === 'usage');
}

type UsageRecordEvent = Extract<AgentEvent, { type: 'usage' }>;

function attemptLedger(events: UsageRecordEvent[]): PlannerUsage {
  const fill = new ContextWindowFill(new SessionWindows());
  return events.reduce((usage, { record }) => addAttemptUsage(usage, fill.fill(record), '2026-10-19T00:01:00Z'), startAttemptUsage(1, 'claude-code', '2026-10-19T00:00:00Z'));
}

function plannerLedger(events: UsageRecordEvent[]): PlannerUsage {
  const ledger = new PlannerUsageLedger();
  for (const { record } of events) ledger.record(record);
  return ledger.snapshot();
}

/** Recorded with a background agent still out: the turn never closes, and `-report` is its close. */
const OPEN_ENDED = new Set(['stream-async-agent']);

const COSTED = readdirSync(join(__dirname, 'fixtures', 'harness', 'claude-code'))
  .map((file) => file.replace(/\.jsonl$/, ''))
  .filter((name) => !OPEN_ENDED.has(name))
  .filter((name) => linesOf(fixture('claude-code', name)).some((l) => l.type === 'result' && typeof l.total_cost_usd === 'number' && l.total_cost_usd > 0));

describe('every recorded Claude Code stream draws what its runner reported', () => {
  it('has recordings to replay', () => {
    expect(COSTED.length).toBeGreaterThan(20);
  });

  describe.each([['a task attempt', 'task', attemptLedger], ['the planner', 'planner', plannerLedger]] as const)('in %s', (_label, kind, ledgerOf) => {
    it.each(COSTED)('%s', async (name) => {
      const text = fixture('claude-code', name);
      const want = reported(linesOf(text));
      const ledger = ledgerOf(await replay(text, kind));

      expect(ledger.totals.reportedCost?.USD).toBeCloseTo(want.cost, 9);
      expect(ledger.totals.costProvenance?.USD).toMatchObject({ kind: 'estimate', billing: want.subscription ? 'subscription' : 'unknown' });
      const fill = plannerContextFill(ledger);
      expect(fill?.usedTokens).toBe(want.meter);
      expect(fill?.windowTokens).toBe(want.window);
    });
  });
});
