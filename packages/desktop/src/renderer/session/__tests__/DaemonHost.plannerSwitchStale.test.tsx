import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import type { HostToWebview } from '@ordewell/ui/protocol';
import type { DaemonCallResult } from '../../../shared/bridge';
import { DaemonHost } from '../DaemonHost';
import { fakeDaemon, ok } from './fakeDaemon';

/**
 * The host half of a planner switch: every daemon answer the switch waits on
 * is a deferred the test releases, so the order the chat receives its planner,
 * catalog and model messages, and the answer to its pick, is fixed by the test.
 */
const WORKSPACE = '/work/acme';
const SETTINGS = {
  orchestratorModel: 'sonnet', aiProvider: 'claude-code', plannerThinkingEffort: 'high',
  autonomousMode: false, maxParallel: 3, modelAllowlist: {}, run: { ...RUN_SETTINGS_DEFAULTS },
};
const RUNNERS = ok({ runners: [
  { id: 'claude-code', name: 'Claude Code', enabled: true },
  { id: 'codex', name: 'Codex', enabled: true },
], orchestratorModel: '' });
const models = (orchestratorModel: string) => ok({
  models: [], modesByRunner: {}, providers: [], orchestratorModels: [], providerErrors: {}, orchestratorModel,
  modelsByRunner: {
    'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] }],
    codex: [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [{ id: 'minimal', label: 'Minimal' }] }],
  },
});

function deferred() {
  let resolve!: (value: DaemonCallResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DaemonCallResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

let hosts: DaemonHost[] = [];
afterEach(() => { for (const h of hosts) h.dispose(); hosts = []; });

/** A host whose first detection answered: Claude Code plans with Sonnet. Then each route waits on `gates`. */
async function settled() {
  let provider = 'claude-code';
  let orchestrator = 'sonnet';
  const gates: Record<string, Array<ReturnType<typeof deferred>>> = { update: [], runners: [], models: [], settings: [] };
  let gated = false;
  const gate = (key: string, value: () => DaemonCallResult) => {
    if (!gated) return value();
    const d = deferred();
    gates[key]!.push(d);
    return d.promise.then(() => value());
  };
  const daemon = fakeDaemon({
    'runners.list': () => gate('runners', () => RUNNERS),
    'models.list': () => gate('models', () => models(orchestrator)),
    'settings.get': () => gate('settings', () => ok({ ...SETTINGS, aiProvider: provider, orchestratorModel: orchestrator })),
    'settings.update': (_p, body) => {
      const apply = () => {
        const env = (body as { env?: Record<string, string> }).env;
        if (env?.AI_PROVIDER) { provider = env.AI_PROVIDER; orchestrator = env.AI_PROVIDER === 'codex' ? 'gpt-5-codex' : 'sonnet'; }
        return ok({ ...SETTINGS, aiProvider: provider });
      };
      if (!gated) return apply();
      const d = deferred();
      gates.update!.push(d);
      return d.promise.then(apply);
    },
  });
  const host = new DaemonHost(WORKSPACE, async () => null, {});
  hosts.push(host);
  const seen: HostToWebview[] = [];
  host.port('conversation').subscribe((m) => seen.push(m));
  await act(() => host.handle({ type: 'ready' }));
  seen.length = 0;
  gated = true;
  const release = async (key: string, i = 0, error?: unknown) => {
    await flush();
    const d = gates[key]![i]!;
    if (error) d.reject(error); else d.resolve(ok(null));
    await flush();
  };
  const ungate = () => { gated = false; };
  return { daemon, host, seen, release, gates, ungate };
}

const kinds = (seen: HostToWebview[]) => seen.map((m) =>
  m.type === 'setPlannerBackends' ? `setPlannerBackends(${m.provider || "''"})`
    : m.type === 'setModelConfig' ? `setModelConfig(${m.modelConfig?.orchestrator})`
      : m.type === 'plannerChoiceSaved' ? `plannerChoiceSaved(${m.requestId})`
        : m.type);

/** Releases every gate still waiting, including those a release opens, until none is left. */
async function drain(gates: Record<string, Array<{ resolve: (v: DaemonCallResult) => void }>>, ungate: () => void) {
  ungate();
  await flush();
  for (const list of Object.values(gates)) for (const d of list) d.resolve(ok(null));
  await flush();
}

describe('DaemonHost planner switch', () => {
  it('sends nothing the chat could settle its pick on while settings.update is in flight', async () => {
    const { host, seen, release } = await settled();
    const switching = host.handle({ type: 'setPlanner', provider: 'codex', requestId: 'r1' });
    await flush();
    expect(kinds(seen)).toEqual([]);
    await release('update');
    await release('settings'); await release('runners'); await release('models');
    await act(() => switching);
  });

  it('answers the pick only after the new planner and its own model have been sent', async () => {
    const { host, seen, release } = await settled();
    const switching = host.handle({ type: 'setPlanner', provider: 'codex', requestId: 'r1' });
    await release('update');
    await release('settings');
    await release('runners');
    // models.list (cold CLI discovery) has not answered: the pick is still the host's.
    expect(kinds(seen)).not.toContain('plannerChoiceSaved(r1)');
    await release('models');
    await act(() => switching);
    const order = kinds(seen);
    const answer = order.indexOf('plannerChoiceSaved(r1)');
    expect(answer, order.join(' → ')).toBe(order.length - 1);
    expect(order.slice(0, answer)).toContain('setModelConfig(gpt-5-codex)');
    expect(order.slice(0, answer).filter((k) => k.startsWith('setPlannerBackends')).at(-1)).toBe('setPlannerBackends(codex)');
  });

  it('answers a refused switch after the error and the planner the daemon still holds', async () => {
    const { host, seen, release } = await settled();
    const switching = host.handle({ type: 'setPlanner', provider: 'codex', requestId: 'r1' });
    await release('update', 0, new Error('settings.update refused'));
    await release('settings'); await release('runners'); await release('models');
    await act(() => switching);
    const order = kinds(seen);
    expect(order[0], order.join(' → ')).toBe('showError');
    expect(order.at(-1)).toBe('plannerChoiceSaved(r1)');
    expect(order.filter((k) => k.startsWith('setPlannerBackends')).at(-1)).toBe('setPlannerBackends(claude-code)');
  });

  it('answers a switch whose model discovery failed, with the planner it saved', async () => {
    const { host, seen, release } = await settled();
    const switching = host.handle({ type: 'setPlanner', provider: 'codex', requestId: 'r1' });
    await release('update');
    await release('settings'); await release('runners');
    await release('models', 0, new Error('models.list timed out'));
    await act(() => switching);
    const order = kinds(seen);
    expect(order.at(-1), order.join(' → ')).toBe('plannerChoiceSaved(r1)');
    expect(order.filter((k) => k.startsWith('setPlannerBackends')).at(-1)).toBe('setPlannerBackends(codex)');
  });

  it('saves the last of two rapid picks and answers both', async () => {
    const { daemon, host, seen, gates, ungate } = await settled();
    const first = host.handle({ type: 'setPlanner', provider: 'codex', requestId: 'r1' });
    const second = host.handle({ type: 'setPlanner', provider: 'claude-code', requestId: 'r2' });
    await flush();
    const inFlight = daemon.calls('settings.update').length;
    await drain(gates, ungate);
    await act(() => Promise.allSettled([first, second]));
    const saved = await window.ordewell.daemon.call('settings.get', { workspace: WORKSPACE });
    expect({ inFlight, saved: (saved.data as { aiProvider: string } | undefined)?.aiProvider })
      .toEqual({ inFlight: 1, saved: 'claude-code' });
    const order = kinds(seen);
    expect(order.filter((k) => k.startsWith('plannerChoiceSaved')).sort()).toEqual(['plannerChoiceSaved(r1)', 'plannerChoiceSaved(r2)']);
    // The later pick's answer comes after the planner it saved.
    expect(order.at(-1), order.join(' → ')).toBe('plannerChoiceSaved(r2)');
    expect(order.filter((k) => k.startsWith('setPlannerBackends')).at(-1)).toBe('setPlannerBackends(claude-code)');
  });
});
