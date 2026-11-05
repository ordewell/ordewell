import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

// A fake key in OpenRouter's shape: a known prefix, then the 64 characters that are the secret.
const SECRET_PART = 'fa4e0d1c2b3a49586776a5b4c3d2e1f0fa4e0d1c2b3a49586776a5b4c3d2e1f0';
const FAKE_KEY = `sk-or-v1-${SECRET_PART}`;
const MANIFEST = {
  name: 'fake-acp', displayName: 'Fake Agent', runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [{ id: 'ask', label: 'Ask', description: 'Asks.', safe: true }],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;
const PROFILE: AcpProfile = {
  manifest: MANIFEST, args: ['--acp'], ordewellTool: () => null, instructions: { kind: 'prompt' },
  credentials: async () => ({ OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }),
};
const INITIALIZED = { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: 'fake-agent', version: '1.0.0' } };
const adapters: AcpAdapter[] = [];
afterEach(() => { for (const a of adapters.splice(0)) a.dispose(); });

function setup(steps: (spawned: ReturnType<typeof fakeAcpSpawn>) => FakeAcpStep[]) {
  const holder: FakeAcpStep[] = [];
  const spawned = fakeAcpSpawn(holder);
  holder.push(...steps(spawned));
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no http'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true, workspaceEnv: async () => ({}),
  };
  const adapter = new AcpAdapter(deps, PROFILE);
  adapters.push(adapter);
  return { adapter, spawned };
}
const start = (): TaskStartOptions => ({ kind: 'task', cwd: '/repo', mode: 'ask', flags: resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-fake-123-echoed' }) });

describe('the stderr tail, when its 4000-char cut falls inside a key', () => {
  it('keeps the secret part of the key out when the cut falls inside the key', async () => {
    // The agent prints its settings, the key among them, then 3935 more chars of log before it dies:
    // the kept tail starts right after `sk-or-v1-`.
    const after = '\n' + 'debug: loading extension manifest\n'.repeat(200).slice(0, 3935);
    const { adapter, spawned } = setup((s) => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { run: (agent) => { s.processes[0].emitStderr(`settings: {"apiKey":"${FAKE_KEY}"}`.replace(`"}`, '') + after); void agent.close(1); } },
    ]);
    const err = await adapter.start(start()).then(() => null, (e: Error) => e);
    expect(spawned.lastEnv()?.OPENAI_API_KEY).toBe(FAKE_KEY);
    expect(err?.message).toContain('exited before it answered session/new');
    const leaked = err?.message.includes(SECRET_PART) ?? false;
    expect({ leaked, head: err?.message.split('\n\n')[1]?.slice(0, 20).replace(/[0-9a-f]{8,}/g, '<HEX>') }).toEqual({ leaked: false, head: expect.any(String) });
  });
});
