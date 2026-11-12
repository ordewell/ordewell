import { afterEach, describe, expect, it } from 'vitest';
import { spawn as nodeSpawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import type { AgentEvent, AgentProcessDeps, SpawnFn, TaskStartOptions } from '../AgentAdapter';
import { removeDir } from '../../../testing';

/**
 * The usage OpenCode 2.2.7 reports in places a step's own end does not: a
 * child session's `session.usage.recorded`, and a `session.step.ended` that
 * arrives after the session went idle. Run against the fake serve
 * (bench/pipeline/fake-opencode/fake-opencode-v2.mjs), whose cues say what to send.
 */
const FAKE = resolve(__dirname, '../../../../../../bench/pipeline/fake-opencode/fake-opencode-v2.mjs');
const cue = (spec: unknown) => `go <fake-opencode>${JSON.stringify(spec)}</fake-opencode>`;

const dirs: string[] = [];
const adapters: OpenCodeAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  for (const dir of dirs.splice(0)) await removeDir(dir);
});

async function started(): Promise<OpenCodeAdapter> {
  const cwd = mkdtempSync(join(tmpdir(), 'oc-v2-usage-'));
  dirs.push(cwd);
  const spawn: SpawnFn = (_command, argv, options) => nodeSpawn(process.execPath, [FAKE, ...argv.slice(1)], options);
  const deps: AgentProcessDeps = {
    spawn,
    fetch: globalThis.fetch,
    exists: () => true,
    isDirectory: () => true,
    workspaceEnv: async () => ({}),
  };
  const adapter = new OpenCodeAdapter(deps);
  adapters.push(adapter);
  const opts: TaskStartOptions = { kind: 'task', cwd, mode: 'build', model: 'fake/fake-model', flags: { permissionMode: 'build', modeSettings: { approvals: 'auto' } } };
  await adapter.start(opts);
  return adapter;
}

async function turn(spec: unknown): Promise<AgentEvent[]> {
  const adapter = await started();
  const events: AgentEvent[] = [];
  await adapter.send(cue(spec), (e) => events.push(e));
  return events;
}

const usageOf = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'usage' ? [e.record] : []));

describe('OpenCode 2.x — usage beyond a step\'s own end', () => {
  it('counts a child session\'s session.usage.recorded as the call it names', async () => {
    const events = await turn({ recorded: [{ source: 'title', child: true, input: 410, output: 9, cost: 0.002 }], usage: { input: 10, output: 5, cost: 0.001 } });
    expect(usageOf(events)).toHaveLength(2);
    expect(usageOf(events).find((r) => r?.purpose === 'title')).toMatchObject({ inputTokens: 410, outputTokens: 9, aggregate: true, reportedCost: { amount: 0.002 } });
  });

  it('counts a main session\'s session.usage.recorded as before, once', async () => {
    const events = await turn({ recorded: [{ source: 'compaction', input: 600, output: 20, cost: 0.004 }], usage: { input: 10, output: 5, cost: 0.001 } });
    expect(usageOf(events).filter((r) => r?.purpose === 'compaction')).toHaveLength(1);
  });

  it('waits for the step in flight when the turn ends first, so its usage lands before the turn ends', async () => {
    const events = await turn({ lateEndMs: 300, usage: { input: 77, output: 3, cost: 0.005 } });
    const types = events.map((e) => e.type);
    expect(usageOf(events)).toHaveLength(1);
    expect(usageOf(events)[0]).toMatchObject({ inputTokens: 77, outputTokens: 3, reportedCost: { amount: 0.005 } });
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('turn_end'));
  });

  it('gives up on a step that never ends within a short grace, and still ends the turn', async () => {
    const began = Date.now();
    const events = await turn({ lateEndMs: 60_000, usage: { input: 77, output: 3, cost: 0.005 } });
    expect(usageOf(events)).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn_end' });
    expect(Date.now() - began).toBeLessThan(10_000);
  });
});
