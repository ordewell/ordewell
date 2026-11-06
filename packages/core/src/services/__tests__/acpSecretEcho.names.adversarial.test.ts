import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';
import { redactAgentText, redactSourceText } from '../../utils/redactSecrets';
import { LineTail } from '../../utils/lineTail';

// Fakes only. HANDED is what Ordewell's hook hands the spawn; the others are keys
// the agent read from its OWN settings (as qwen did from ~/.qwen/settings.json's env),
// so neither the held set nor the spawn env knows them: only the name rules can.
const HANDED = 'sk-or-v1-FAKEFAKEFAKEFAKEFAKE0000review73r3';
const DASHED = 'csk-4f8e2a91c7b3d5e6f8a0b2c4d6e8f0a1fake';
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const TOKEN = 'Q7wE9rT1yU3iO5pA7sD9fG1hJ3kL5zXfake';
const BEARER = 'zX9cV7bN5mQ3wE1rT9yU7iO5pA3sD1fGfake';

const MANIFEST = {
  name: 'fake-acp', displayName: 'Fake Agent', runner: { command: 'fake-agent' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'hardcoded', models: [] },
  modes: [{ id: 'ask', label: 'Ask', description: 'Asks.', safe: true }],
  auth: { statusArgs: ['status'], loginArgs: ['login'] },
} as RunnerManifest;
const PROFILE: AcpProfile = {
  manifest: MANIFEST, args: ['--acp'], ordewellTool: () => null, instructions: { kind: 'prompt' },
  credentials: async () => ({ OPENAI_API_KEY: HANDED, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }),
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
const start = (): TaskStartOptions => ({ kind: 'task', cwd: '/repo', mode: 'ask', flags: resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-fake-123-echoed-r3' }) });

async function startErrorFor(stderr: string): Promise<string> {
  const { adapter } = setup((s) => [
    { expect: 'initialize', reply: INITIALIZED },
    { expect: 'session/new' },
    { run: (agent) => { s.processes[0].emitStderr(stderr); void agent.close(1); } },
  ]);
  const err = await adapter.start(start()).then(() => null, (e: Error) => e);
  expect(err?.message).toContain('exited before it answered session/new');
  return err?.message ?? '';
}
const leaked = (message: string, key: string) => message.includes(key);
const LOG = '\n' + 'debug: loading extension manifest\n'.repeat(200);

describe('a key under a credential name, echoed by the agent', () => {
  it('control: the dashed key under CEREBRAS_API_KEY is redacted when the tail is not cut', async () => {
    const msg = await startErrorFor(`Invalid configuration: {"env":{"CEREBRAS_API_KEY":"${DASHED}"}}\n`);
    expect(leaked(msg, DASHED)).toBe(false);
  });

  it('the same key stays out when the 4000-char cut falls inside its name', async () => {
    const tailFrom = `API_KEY":"${DASHED}"}}`;
    const after = LOG.slice(0, 4000 - tailFrom.length);
    const msg = await startErrorFor(`Invalid configuration: {"env":{"CEREBRAS_${tailFrom}${after}`);
    expect(msg).toContain('debug: loading extension manifest');
    expect(leaked(msg, DASHED)).toBe(false);
  });

  it('a pure-alphanumeric key under MISTRAL_API_KEY in stderr JSON (no cut)', async () => {
    const msg = await startErrorFor(`Invalid configuration: {"env":{"MISTRAL_API_KEY":"${ALNUM}"}}\n`);
    expect(leaked(msg, ALNUM)).toBe(false);
  });

  it('an alphanumeric token under *_TOKEN in stderr JSON (no cut)', async () => {
    const msg = await startErrorFor(`settings: {"env":{"ANYSCALE_TOKEN":"${TOKEN}"}}\n`);
    expect(leaked(msg, TOKEN)).toBe(false);
  });

  it('a bearer token under Authorization in stderr JSON (no cut)', async () => {
    const msg = await startErrorFor(`mcp: {"headers":{"Authorization":"Bearer ${BEARER}"}}\n`);
    expect(leaked(msg, BEARER)).toBe(false);
  });

  it('a pure-alphanumeric key under *_API_KEY in a session/new refusal message', async () => {
    const { adapter } = setup(() => [
      { expect: 'initialize', reply: INITIALIZED },
      { expect: 'session/new', error: { code: -32603, message: `Invalid configuration: {"env":{"MISTRAL_API_KEY":"${ALNUM}"}}` } },
    ]);
    const err = await adapter.start(start()).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(leaked(err?.message ?? '', ALNUM)).toBe(false);
  });
});

// A fake PEM body: 30 lines of 64 base64 chars that encode nothing.
const PEM_LINES = Array.from({ length: 30 }, (_, i) => `FAKEpem${String(i).padStart(2, '0')}`.padEnd(64, 'QWERTYuiop0123456789+/asdfGHJKLzxcvbnm'.slice(i % 7)).slice(0, 64));
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_LINES.join('\n')}\n-----END PRIVATE KEY-----\n`;
const bodyLeaked = (message: string) => PEM_LINES.filter((l) => message.includes(l)).length;

describe('a name cut by the tail is cut after it was redacted', () => {
  it('redacts the value under the end of a cut name', () => {
    const tail = `API_KEY":"${DASHED}"}}` + LOG.slice(0, 200);
    expect(redactAgentText(tail.trim()).includes(DASHED)).toBe(false);
  });
  it('shows a tail cut inside the name only once the whole line was redacted', () => {
    const tail = new LineTail({ keepChars: 16_000, showChars: 4000 });
    const after = LOG.slice(0, 4000 - `API_KEY":"${DASHED}"}}`.length);
    tail.append(`Invalid configuration: {"env":{"CEREBRAS_API_KEY":"${DASHED}"}}${after}`);
    expect(tail.read((text) => redactAgentText(text)).includes(DASHED)).toBe(false);
  });
});

describe('PEM private keys', () => {
  it('control: an uncut PEM block in stderr is redacted', async () => {
    const msg = await startErrorFor(`ssh: bad key\n${PEM}`);
    expect(bodyLeaked(msg)).toBe(0);
  });
  it('a PEM block whose BEGIN line falls before the 4000-char cut reaches the start error', async () => {
    const afterBegin = PEM.slice(PEM.indexOf('\n') + 1);
    const keep = afterBegin.slice(64 * 5 + 7); // cut inside the 6th body line
    const padding = LOG.slice(0, 4000 - keep.length);
    const msg = await startErrorFor(`ssh: bad key\n${PEM}${padding}`);
    expect(msg).toContain('-----END PRIVATE KEY-----');
    expect(bodyLeaked(msg)).toBe(0);
  });
  it('a JSON-escaped PEM (a service-account file) is redacted, in both modes', () => {
    const json = JSON.stringify({ type: 'service_account', project_id: 'fake-proj', private_key: PEM, client_email: 'x@fake-proj.iam.gserviceaccount.com' }, null, 2);
    expect(bodyLeaked(redactSourceText(json))).toBe(0);
    expect(bodyLeaked(redactAgentText(json))).toBe(0);
  });
});
