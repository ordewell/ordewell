import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

/**
 * Task #76, round 2: shapes redactAgentText misses (redactSecrets.bar76r2), carried
 * end to end to the two sinks agent text reaches at start: the stderr tail of a
 * start error and the message of a JSON-RPC error. Every value here is fake.
 */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const HEX = 'dbcdef0123456789abcdef0123456789';
const MCP_TOKEN = 'tok-fake-123-bar76-adversarial';

const shows = (message: string, secret: string) =>
  Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((piece) => message.includes(piece));

const MANIFEST = {
  name: 'fake-acp', displayName: 'Fake Agent', runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [{ id: 'ask', label: 'Ask', description: 'Asks.', safe: true }],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;
const PROFILE: AcpProfile = {
  manifest: MANIFEST, args: ['--acp'], ordewellTool: () => null, instructions: { kind: 'prompt' },
  credentials: async () => ({ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }),
};
const INITIALIZED = { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: 'fake-agent', version: '1.0.0' } };
const adapters: AcpAdapter[] = [];
afterEach(() => { for (const a of adapters.splice(0)) a.dispose(); });

function setup(steps: (spawned: ReturnType<typeof fakeAcpSpawn>) => FakeAcpStep[], workspace: Record<string, string> = {}) {
  const holder: FakeAcpStep[] = [];
  const spawned = fakeAcpSpawn(holder);
  holder.push(...steps(spawned));
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no http'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true, workspaceEnv: async () => workspace,
  };
  const adapter = new AcpAdapter(deps, PROFILE);
  adapters.push(adapter);
  return adapter;
}
const start = (): TaskStartOptions => ({ kind: 'task', cwd: '/repo', mode: 'ask', flags: resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: MCP_TOKEN }) });

/** The start error of an agent that writes `stderr` and exits before it answers session/new. */
async function startErrorFor(stderr: string, workspace: Record<string, string> = {}): Promise<string> {
  const adapter = setup((s) => [
    { expect: 'initialize', reply: INITIALIZED },
    { expect: 'session/new' },
    { run: (agent) => { s.processes[0].emitStderr(stderr); void agent.close(1); } },
  ], workspace);
  const err = await adapter.start(start()).then(() => null, (e: Error) => e);
  expect(err?.message).toContain('exited before it answered session/new');
  return err?.message ?? '';
}

/** The start error of an agent that refuses session/new with `message`. */
async function refusalFor(message: string): Promise<string> {
  const adapter = setup(() => [
    { expect: 'initialize', reply: INITIALIZED },
    { expect: 'session/new', error: { code: -32603, message } },
  ]);
  const err = await adapter.start(start()).then(() => null, (e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  return err?.message ?? '';
}

describe('bar (b), round 2: a start error carries a credential-named value redactAgentText misses', () => {
  it('keeps a scheme-less Authorization header out of the stderr tail', async () => {
    const message = await startErrorFor(`> POST /v1/chat/completions\n> Authorization: ${HEX}\n< 401 Unauthorized\n`);
    expect(shows(message, HEX), message).toBe(false);
  });

  it('keeps a numbered *_API_KEY out of the stderr tail', async () => {
    const message = await startErrorFor(`config loaded\nMISTRAL_API_KEY_2: ${ALNUM}\nerror: model not found\n`);
    expect(shows(message, ALNUM), message).toBe(false);
  });

  it('keeps an env line inside a JSON-encoded error out of a JSON-RPC error message', async () => {
    const message = await refusalFor(`{"error":"spawn failed:\\nMISTRAL_API_KEY=${ALNUM}\\nHOME=/home/u"}`);
    expect(shows(message, ALNUM), message).toBe(false);
  });

  it('keeps a camelCase apiKey out of a JSON-RPC error message', async () => {
    const message = await refusalFor(`invalid provider config: apiKey: ${HEX} was rejected`);
    expect(shows(message, HEX), message).toBe(false);
  });

  it('keeps a *_API_KEY in YAML out of a JSON-RPC error message (control, passes today)', async () => {
    const message = await refusalFor(`invalid provider config:\n  MISTRAL_API_KEY: ${ALNUM}\n`);
    expect(shows(message, ALNUM), message).toBe(false);
  });
});
