import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

// Fake keys, never real ones. The second has no shape a pattern knows, so
// only this spawn's own values can catch it.
const FAKE_KEY = 'sk-or-v1-FAKEFAKEFAKEFAKEFAKE0000review73';
const SHAPELESS_KEY = 'plainfakekeyvalue0123456789';
const MCP_TOKEN = 'tok-fake-123-echoed';
const ECHO = JSON.stringify({ env: { OPENROUTER_API_KEY: FAKE_KEY }, security: { auth: { selectedType: 'openai' } } });

const MANIFEST = {
  name: 'fake-acp', displayName: 'Fake Agent', runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [{ id: 'ask', label: 'Ask', description: 'Asks.', safe: true }],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;
const PROFILE: AcpProfile = {
  manifest: MANIFEST, args: ['--acp'], ordewellTool: () => null, instructions: { kind: 'prompt' },
  credentials: async () => ({ OPENAI_API_KEY: FAKE_KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', CLINE_API_KEY: SHAPELESS_KEY }),
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
const start = (): TaskStartOptions => ({ kind: 'task', cwd: '/repo', mode: 'ask', flags: resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: MCP_TOKEN }) });

describe('a secret an ACP agent echoes back stays out of Ordewell\'s messages (ADR-0060 R9)', () => {
  it('keeps the key out of the start error\'s stderr tail when the agent prints its settings and exits', async () => {
    const { adapter, spawned } = setup((s) => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { run: (agent) => { s.processes[0].emitStderr(`Fatal: bad settings ${ECHO}\n`); void agent.close(1); } },
    ]);
    const err = await adapter.start(start()).then(() => null, (e: Error) => e);
    expect(spawned.lastEnv()?.OPENAI_API_KEY).toBe(FAKE_KEY);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain(FAKE_KEY);
  });

  it('keeps the key out of a session/new refusal\'s message', async () => {
    const { adapter } = setup(() => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', error: { code: -32603, message: `Invalid configuration: ${ECHO}` } },
    ]);
    const err = await adapter.start(start()).then(() => null, (e: Error) => e);
    expect(err?.message).not.toContain(FAKE_KEY);
  });

  it('keeps the key out of the error a session/prompt refusal becomes', async () => {
    const { adapter } = setup(() => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', reply: { sessionId: 'sess-1' } },
      { expect: 'session/prompt', error: { code: -32603, message: `Provider error 401 for request ${ECHO}` } },
    ]);
    await adapter.start(start());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
  });

  it('keeps the key out of the stderr tail of an agent that dies mid-turn', async () => {
    const { adapter } = setup((s) => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', reply: { sessionId: 'sess-1' } },
      { expect: 'session/prompt' },
      { run: (agent) => { s.processes[0].emitStderr(`[debug] env ${ECHO}\n`); void agent.close(1); } },
    ]);
    await adapter.start(start());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
  });

  it('keeps out a key of no known shape, and the MCP token, by this spawn\'s own values', async () => {
    const { adapter, spawned } = setup((s) => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new' },
      { run: (agent) => { s.processes[0].emitStderr(`key ${SHAPELESS_KEY} token ${MCP_TOKEN}\n`); void agent.close(1); } },
    ]);
    const err = await adapter.start(start()).then(() => null, (e: Error) => e);
    expect(spawned.lastEnv()?.CLINE_API_KEY).toBe(SHAPELESS_KEY);
    expect(err?.message).toContain('exited before it answered session/new');
    expect(err?.message).not.toContain(SHAPELESS_KEY);
    expect(err?.message).not.toContain(MCP_TOKEN);
  });
});
