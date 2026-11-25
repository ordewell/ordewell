import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelDiscovery, type AcpClientImpl } from '../ModelDiscovery';
import { ModelResolver } from '../ModelResolver';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerManifest } from '../../plugins/types';
import { CURSOR_AGENT_MANIFEST } from '../../plugins/builtin/cursor-agent.manifest';
import { CLINE_MANIFEST } from '../../plugins/builtin/cline.manifest';
import { forgetRunnerAuth, recordedRunnerAuth, recordedRunnerEvidence, resetRunnerAuth } from '../runnerAuth';
import { fakeConfig } from '../../testing';

/**
 * #46 F4–F6: discovery's own ACP handshake is evidence about the agent's
 * sign-in, recorded for the workspace it was asked under, and why a runner
 * lists nothing is told apart: a blocker (signed out, no credential), a
 * pending ask, an ask that got no answer, and an agent that answered with no
 * model choice and so runs on its own default.
 */

function registryWith(...manifests: RunnerManifest[]): RunnerRegistry {
  return { getManifest: (id: string) => manifests.find((m) => m.name === id) } as unknown as RunnerRegistry;
}

const noExec = vi.fn(async () => { throw new Error('no command discovery here'); });

function discoveryOf(manifest: RunnerManifest, client: AcpClientImpl, workspace = '/w') {
  return new ModelDiscovery(registryWith(manifest), noExec, undefined, undefined, undefined, undefined, async () => ({}), client, () => workspace);
}

beforeEach(() => resetRunnerAuth());

describe('ModelDiscovery readiness (#46 F4–F6)', () => {
  it('records an auth-required answer as signed out, from discovery, for its own workspace only', async () => {
    const discovery = discoveryOf(CURSOR_AGENT_MANIFEST, vi.fn(async () => 'signed-out' as const));

    expect(await discovery.discover('cursor-agent')).toEqual([]);

    expect(discovery.whyUnlisted()).toEqual({ 'cursor-agent': 'signed-out' });
    expect(recordedRunnerEvidence('cursor-agent', '/w')).toMatchObject({ source: 'discovery', auth: { state: 'signed-out', signIn: { runner: 'cursor-agent' } } });
    expect(recordedRunnerAuth('cursor-agent', '/v')).toBeUndefined();
  });

  it('records a session the agent opened as signed in, and an empty answer as the agent\'s own default', async () => {
    const discovery = discoveryOf(CURSOR_AGENT_MANIFEST, vi.fn(async () => []));

    expect(await discovery.discover('cursor-agent')).toEqual([]);

    expect(discovery.whyUnlisted()).toEqual({ 'cursor-agent': 'no-choice' });
    expect(recordedRunnerEvidence('cursor-agent', '/w')).toMatchObject({ source: 'discovery', auth: { state: 'signed-in' } });
  });

  it('records nothing for an ask that got no answer, and says so', async () => {
    const discovery = discoveryOf(CURSOR_AGENT_MANIFEST, vi.fn(async () => null));

    await discovery.discover('cursor-agent');

    expect(discovery.whyUnlisted()).toEqual({ 'cursor-agent': 'no-answer' });
    expect(recordedRunnerAuth('cursor-agent', '/w')).toBeUndefined();
  });

  it('says a discovery still running is pending, not empty', async () => {
    let answer!: (models: []) => void;
    const discovery = discoveryOf(CURSOR_AGENT_MANIFEST, vi.fn(() => new Promise<[]>((resolve) => { answer = resolve; })));

    const running = discovery.discover('cursor-agent');
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(discovery.whyUnlisted()).toEqual({ 'cursor-agent': 'pending' });
    answer([]);
    await running;
    expect(discovery.whyUnlisted()).toEqual({ 'cursor-agent': 'no-choice' });
  });

  it('tells a finished, empty catalog from a degraded one for a runner with no handshake', async () => {
    const bare: RunnerManifest = { ...CLINE_MANIFEST, name: 'bare', displayName: 'Bare', modelDiscovery: { method: 'hardcoded' } };
    const listed = discoveryOf(bare, vi.fn(async () => null));
    await listed.discover('bare');
    // Its own complete catalog, and empty: nothing to run it on.
    expect(listed.whyUnlisted()).toEqual({ bare: 'no-models' });

    const cli: RunnerManifest = { ...bare, modelDiscovery: { method: 'command', command: 'bare', args: ['models'] } };
    const unreached = discoveryOf(cli, vi.fn(async () => null));
    await unreached.discover('bare');
    // The command failed and only the empty fallback answered: no evidence either way.
    expect(unreached.whyUnlisted()).toEqual({ bare: 'no-answer' });
  });

  it('keeps Cline\'s credential refusal as its reason, worded by the resolver, without asking the agent', async () => {
    const client: AcpClientImpl = vi.fn(async () => []);
    const resolver = new ModelResolver(registryWith(CLINE_MANIFEST), fakeConfig(), { env: async () => ({}), acpClient: client, workspace: () => '/w' });

    expect(await resolver.modelsForRunners(['cline'])).toEqual({ cline: [] });

    expect(client).not.toHaveBeenCalled();
    expect(resolver.getRunnerUnlisted()).toEqual({ cline: 'no-credential' });
    const said = resolver.getRunnerDiscoveryErrors().cline;
    expect(said).toMatch(/^Cline has no provider key Ordewell can hand it: .*is missing\. Run `cline auth` and choose a provider with its API key \(a Cline or ClinePass account sign-in leaves no key Ordewell can read\)/);
    // The verdict says the agent lacks a key, not that it refused, so a surface reading it alone words a setup.
    expect(recordedRunnerEvidence('cline', '/w')).toMatchObject({ source: 'discovery', auth: {
      state: 'signed-out', detail: 'no provider key', signIn: { runner: 'cline', label: 'Cline', login: ['cline', 'auth'], needsKey: true },
    } });
  });

  it('words only the blockers as discovery errors: an agent default or a pending ask is no error', async () => {
    const resolver = new ModelResolver(registryWith(CURSOR_AGENT_MANIFEST), fakeConfig(), { env: async () => ({}), acpClient: vi.fn(async () => []), workspace: () => '/w' });

    await resolver.modelsForRunners(['cursor-agent']);

    expect(resolver.getRunnerUnlisted()).toEqual({ 'cursor-agent': 'no-choice' });
    expect(resolver.getRunnerDiscoveryErrors()).toEqual({});
  });

  it('drops an answer asked before the user signed in again, so a stale refusal is not recorded over the login', async () => {
    let answer!: (said: 'signed-out') => void;
    const discovery = discoveryOf(CURSOR_AGENT_MANIFEST, vi.fn(() => new Promise<'signed-out'>((resolve) => { answer = resolve; })));

    const running = discovery.discover('cursor-agent');
    await vi.waitFor(() => expect(answer).toBeDefined());
    forgetRunnerAuth('cursor-agent', '/w');
    answer('signed-out');
    await running;

    expect(recordedRunnerAuth('cursor-agent', '/w')).toBeUndefined();
  });
});
