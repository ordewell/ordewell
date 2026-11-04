import { describe, it, expect, vi } from 'vitest';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerManifest } from '../../plugins/types';
import type { DiscoveredModel } from '../../models/Task';

function registryWith(manifest: RunnerManifest): RunnerRegistry {
  return { getManifest: (id: string) => (id === manifest.name ? manifest : undefined) } as unknown as RunnerRegistry;
}

const agent: RunnerManifest = {
  name: 'acp-agent',
  displayName: 'ACP Agent',
  runner: { command: 'acp-agent' },
  features: {},
  modelDiscovery: {
    method: 'acp',
    acp: { args: ['--acp'] },
    discoveryCommands: [{ command: 'acp-agent', args: ['models'], parser: (out: string) => out.split('\n').filter(Boolean).map((id) => ({ modelId: id, modelLabel: id, variants: [] })) }],
  },
};

const OFFERED: DiscoveredModel[] = [{ modelId: 'small', modelLabel: 'Small', variants: [{ id: 'low', label: 'Low' }] }];

const execOf = (stdout: string): ExecImpl => vi.fn(async () => ({ stdout }));

describe('ModelDiscovery — the acp method', () => {
  it('asks the agent, started with the manifest\'s ACP arguments, and stamps what it offers with the runner', async () => {
    const client: AcpClientImpl = vi.fn(async () => OFFERED);
    const exec = execOf('never-used');
    const discovery = new ModelDiscovery(registryWith(agent), exec, undefined, undefined, undefined, undefined, undefined, client);

    const models = await discovery.discover('acp-agent');

    expect(client).toHaveBeenCalledWith('acp-agent', ['--acp'], expect.objectContaining({ env: expect.any(Object) }));
    expect(models).toEqual([{ ...OFFERED[0], runnerId: 'acp-agent', runnerLabel: 'ACP Agent' }]);
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to the manifest\'s own commands when the agent cannot be asked (signed out, missing, silent)', async () => {
    const client: AcpClientImpl = vi.fn(async () => null);
    const discovery = new ModelDiscovery(registryWith(agent), execOf('alpha\nbeta\n'), undefined, undefined, undefined, undefined, undefined, client);

    const models = await discovery.discover('acp-agent');

    expect(models.map((m) => m.modelId)).toEqual(['alpha', 'beta']);
  });

  it('falls back when the agent answers but offers no model choice', async () => {
    const client: AcpClientImpl = vi.fn(async () => []);
    const discovery = new ModelDiscovery(registryWith(agent), execOf('alpha\n'), undefined, undefined, undefined, undefined, undefined, client);

    expect((await discovery.discover('acp-agent')).map((m) => m.modelId)).toEqual(['alpha']);
  });

  it('asks the agent once, then serves the cached list until a refresh', async () => {
    const client: AcpClientImpl = vi.fn(async () => OFFERED);
    const discovery = new ModelDiscovery(registryWith(agent), execOf(''), undefined, undefined, undefined, undefined, undefined, client);

    await discovery.discover('acp-agent');
    await discovery.discover('acp-agent');
    expect(client).toHaveBeenCalledTimes(1);

    discovery.clear();
    await discovery.discover('acp-agent');
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('answers the manifest\'s aliases when neither the agent nor its commands deliver, and retries after the negative window', async () => {
    let now = 1_000;
    const client: AcpClientImpl = vi.fn(async () => null);
    const exec: ExecImpl = vi.fn(async () => { throw new Error('not installed'); });
    const aliased: RunnerManifest = { ...agent, modelDiscovery: { ...agent.modelDiscovery, canonicalAliases: [{ modelId: 'auto', modelLabel: 'Auto' }] } };
    const discovery = new ModelDiscovery(registryWith(aliased), exec, undefined, undefined, undefined, () => now, undefined, client);

    expect((await discovery.discover('acp-agent')).map((m) => m.modelId)).toEqual(['auto']);
    await discovery.discover('acp-agent');
    expect(client).toHaveBeenCalledTimes(1);
    now += 61_000;
    await discovery.discover('acp-agent');
    expect(client).toHaveBeenCalledTimes(2);
  });
});

describe('ModelDiscovery — the acp method with a credential hook', () => {
  const KEY = 'sk-discovery-key-never-shown';

  it('starts the agent under the runner\'s env, then the profile\'s, then the key the hook read from that runner env', async () => {
    const credentials = vi.fn(async () => ({ AGENT_API_KEY: KEY }));
    const keyed: RunnerManifest = { ...agent, modelDiscovery: { ...agent.modelDiscovery, acp: { args: ['--acp'], env: { AGENT_MODE: 'local' }, credentials } } };
    const client: AcpClientImpl = vi.fn(async () => OFFERED);
    const runnerEnv = { HOME: '/home/someone', AGENT_MODE: 'shared' };
    const discovery = new ModelDiscovery(registryWith(keyed), execOf(''), undefined, undefined, undefined, undefined, async () => runnerEnv, client);

    expect((await discovery.discover('acp-agent')).map((m) => m.modelId)).toEqual(['small']);
    expect(credentials).toHaveBeenCalledWith({ env: runnerEnv });
    expect(client).toHaveBeenCalledWith('acp-agent', ['--acp'], { env: { HOME: '/home/someone', AGENT_MODE: 'local', AGENT_API_KEY: KEY } });
  });

  it('spawns nothing when the hook finds no key, falls back, and asks again once the user has signed in', async () => {
    let now = 1_000;
    let stored: string | null = null;
    const credentials = vi.fn(async () => {
      if (!stored) throw new Error('Cline has no provider key Ordewell can hand it');
      return { AGENT_API_KEY: stored };
    });
    const keyed: RunnerManifest = { ...agent, modelDiscovery: { ...agent.modelDiscovery, acp: { args: ['--acp'], credentials } } };
    const client: AcpClientImpl = vi.fn(async () => OFFERED);
    const discovery = new ModelDiscovery(registryWith(keyed), execOf('alpha\n'), undefined, undefined, undefined, () => now, async () => ({}), client);

    expect((await discovery.discover('acp-agent')).map((m) => m.modelId)).toEqual(['alpha']);
    expect(client).not.toHaveBeenCalled();

    stored = KEY;
    now += 61_000;
    expect((await discovery.discover('acp-agent')).map((m) => m.modelId)).toEqual(['small']);
    expect(client).toHaveBeenCalledWith('acp-agent', ['--acp'], { env: { AGENT_API_KEY: KEY } });
  });

  it('starts the agent under the runner\'s env alone when the hook says it needs nothing from Ordewell', async () => {
    const keyed: RunnerManifest = { ...agent, modelDiscovery: { ...agent.modelDiscovery, acp: { args: ['--acp'], credentials: async () => null } } };
    const client: AcpClientImpl = vi.fn(async () => OFFERED);
    const runnerEnv = { AGENT_API_KEY: 'the-users-own' };
    const discovery = new ModelDiscovery(registryWith(keyed), execOf(''), undefined, undefined, undefined, undefined, async () => runnerEnv, client);

    await discovery.discover('acp-agent');
    expect(client).toHaveBeenCalledWith('acp-agent', ['--acp'], { env: runnerEnv });
  });
});

describe('ModelDiscovery — acp failures and canonical aliases', () => {
  it('keeps a failed ACP handshake uncached even when the fallback command answers, so a recovered agent is asked again', async () => {
    let now = 1_000;
    let signedIn = false;
    const client: AcpClientImpl = vi.fn(async () => (signedIn ? OFFERED : null));
    const discovery = new ModelDiscovery(registryWith(agent), execOf('alpha\n'), undefined, undefined, undefined, () => now, undefined, client);

    expect((await discovery.discover('acp-agent')).map((m) => m.modelId)).toEqual(['alpha']);
    signedIn = true;
    now += 61_000;

    const recovered = await discovery.discover('acp-agent');
    expect(client).toHaveBeenCalledTimes(2);
    expect(recovered.map((m) => m.modelId)).toEqual(['small']);
    expect(recovered[0].variants).toEqual(OFFERED[0].variants);
  });

  it('adds the manifest\'s canonical aliases the agent does not list, keeping the agent\'s own variants', async () => {
    const client: AcpClientImpl = vi.fn(async () => OFFERED);
    const aliased: RunnerManifest = { ...agent, modelDiscovery: { ...agent.modelDiscovery, canonicalAliases: [{ modelId: 'auto', modelLabel: 'Auto' }, { modelId: 'small', modelLabel: 'Small again' }] } };
    const discovery = new ModelDiscovery(registryWith(aliased), execOf(''), undefined, undefined, undefined, undefined, undefined, client);

    const models = await discovery.discover('acp-agent');

    expect(models.map((m) => m.modelId)).toEqual(['small', 'auto']);
    expect(models[0].variants).toEqual([{ id: 'low', label: 'Low' }]);
  });
});
