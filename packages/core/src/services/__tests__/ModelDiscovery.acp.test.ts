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
