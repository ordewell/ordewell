import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import type { AcpToolCall } from '../harness/acpSchema';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

const MANIFEST = {
  name: 'fake-acp', displayName: 'Fake Agent', runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [
    { id: 'ask', label: 'Ask', description: 'Asks before it acts.', safe: true },
    { id: 'auto', label: 'Auto', description: 'Acts without asking.', autonomous: true },
  ],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;
const PROFILE: AcpProfile = {
  manifest: MANIFEST, args: ['--acp'],
  ordewellTool: (call: AcpToolCall) => (call.title?.startsWith('ordewell/') ? call.title.slice(9) : null),
  instructions: { kind: 'prompt' },
};
const INITIALIZED = { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, agentInfo: { name: 'fake-agent', version: '1.4.0' } };
const handshake = (): FakeAcpStep[] => [{ expect: 'initialize', reply: INITIALIZED }, { expect: 'session/new', reply: { sessionId: 'sess-1' } }];
const permissionParams = (title: string) => ({
  sessionId: 'sess-1',
  toolCall: { toolCallId: 'call-1', title, kind: 'edit', rawInput: { path: 'src/a.ts' } },
  options: [
    { optionId: 'opt-b', name: 'Allow', kind: 'allow_once' },
    { optionId: 'opt-c', name: 'Reject', kind: 'reject_once' },
  ],
});
const adapters: AcpAdapter[] = [];
afterEach(() => { for (const a of adapters.splice(0)) a.dispose(); });
function setup(steps: FakeAcpStep[]) {
  const spawned = fakeAcpSpawn(steps);
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn, fetch: (async () => { throw new Error('no'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true, workspaceEnv: async () => ({}),
  };
  const adapter = new AcpAdapter(deps, PROFILE);
  adapters.push(adapter);
  return { agent: spawned.agent, adapter };
}
const taskStart = (mode: string): TaskStartOptions => ({
  kind: 'task', cwd: '/repo', mode, flags: resolveTaskRunnerFlags(MANIFEST, { mode }),
  mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' }),
});

describe('ADVERSARIAL: a permission request that crosses session/cancel', () => {
  // Spec (prompt-turn.md, Cancellation): "The Client MUST respond to all pending
  // session/request_permission requests with the cancelled outcome."
  it('auto mode: is answered cancelled, not approved, after the client sent session/cancel', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { expect: 'session/cancel' },
      // The agent raised this before it read the cancel: it crosses on the wire.
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
      { answer: { stopReason: 'cancelled' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart('auto'));
    const events: AgentEvent[] = [];
    const sent = adapter.send('go', (e) => events.push(e));
    await expect.poll(() => agent.requests('session/prompt').length).toBe(1);
    const interrupted = adapter.interrupt(1000);
    await sent;
    expect(await interrupted).toBe(true);
    expect(agent.answers).toEqual([{ method: 'session/request_permission', result: { outcome: { outcome: 'cancelled' } } }]);
  });

  it('ask mode: is not put to a person after the interrupt, and the interrupt is not lost waiting on it', async () => {
    const { agent, adapter } = setup([
      ...handshake(),
      { expect: 'session/prompt' },
      { expect: 'session/cancel' },
      { request: 'session/request_permission', params: permissionParams('Edit src/a.ts') },
      { answer: { stopReason: 'cancelled' }, to: 'session/prompt' },
    ]);
    await adapter.start(taskStart('ask'));
    const events: AgentEvent[] = [];
    void adapter.send('go', (e) => events.push(e));
    await expect.poll(() => agent.requests('session/prompt').length).toBe(1);
    const interrupted = await adapter.interrupt(1000);
    expect({ interrupted, events: events.map((e) => e.type), answers: agent.answers }).toEqual({
      interrupted: true,
      events: ['turn_end'],
      answers: [{ method: 'session/request_permission', result: { outcome: { outcome: 'cancelled' } } }],
    });
  });
});
