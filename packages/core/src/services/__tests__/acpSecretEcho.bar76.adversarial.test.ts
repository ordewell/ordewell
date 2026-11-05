import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

/**
 * Task #76: the two sinks agent text reaches at start, the stderr tail of a
 * start error and the message of a JSON-RPC error, checked against the bar.
 * Every value here is fake.
 *
 * (a) A value Ordewell holds, here one it handed at spawn through the
 *     workspace env under a name isCredentialVariable knows, never reaches a sink.
 * (b) A value under a credential-named key is never shown, whatever its shape
 *     and however it is assigned.
 */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const HEX = 'abcdef0123456789abcdef0123456789';
const LOWER = 'qwertyuiopasdfghjklzxcvbnmfake';
const SLUGGED = 'fake-tkn-qzx-wvy-plm';
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

describe('bar (b): a colon-assigned, unquoted value under a credential name', () => {
  const cases: Array<[string, string, string]> = [
    ['a *_API_KEY in a YAML settings dump', `loaded settings:\n  MISTRAL_API_KEY: ${ALNUM}\n  model: mistral-large\n`, ALNUM],
    ['an x-api-key request header in a debug log', `> POST /v1/messages\n> x-api-key: ${HEX}\n`, HEX],
    ['an X-Goog-Api-Key request header', `> X-Goog-Api-Key: ${ALNUM}\n`, ALNUM],
    ['a harness login token, letters only', `ANTHROPIC_AUTH_TOKEN: ${LOWER}\n`, LOWER],
    ['a *_TOKEN shaped like a slug', `GITHUB_TOKEN: ${SLUGGED}\n`, SLUGGED],
    ['an Authorization header with the Token scheme', `> Authorization: Token ${HEX}\n`, HEX],
    ['an Authorization header with a letters-only Bearer token', `> Authorization: Bearer ${LOWER}\n`, LOWER],
  ];

  for (const [label, text, secret] of cases) {
    it(`keeps ${label} out of the stderr tail of a start error`, async () => {
      const message = await startErrorFor(text);
      expect(shows(message, secret), message).toBe(false);
    });

    it(`keeps ${label} out of a JSON-RPC error's message`, async () => {
      const message = await refusalFor(`request failed: ${text}`);
      expect(shows(message, secret), message).toBe(false);
    });
  }

  it('keeps an `=`-assigned value of the same shape out (control, passes today)', async () => {
    const message = await startErrorFor(`MISTRAL_API_KEY=${LOWER}\n`);
    expect(shows(message, LOWER), message).toBe(false);
  });
});

describe('bar (a): a value Ordewell handed at spawn, echoed bare', () => {
  // The workspace env is passed to the runner (runnerProcess.ts:159), and the
  // redactor holds only sensitiveEnvValues(spawnEnv), whose name test
  // (outboundSecrets.ts:8) misses names isCredentialVariable knows.
  const handed: Record<string, string> = {
    PGPASSWORD: 'FakePgPass0123xyz',
    MYSQL_PWD: 'FakeMyPwd0123xyz',
    GITHUB_PAT: 'FakePat0123456789abcxyz',
    DEPLOY_SSH_PASSPHRASE: 'FakePassphrase0123xyz',
    SENTRY_DSN: 'https://FakeDsnKey0123456789abcdef@o1.ingest.example.io/1',
    DATABASE_URL: 'postgres://fakeuser:FakeDbPass0123xyz@db.example/app',
    SLACK_WEBHOOK_URL: 'https://hooks.example.com/services/T000/B000/FakeHook0123456789xyz',
  };
  const bare: Record<string, string> = {
    PGPASSWORD: handed.PGPASSWORD,
    MYSQL_PWD: handed.MYSQL_PWD,
    GITHUB_PAT: handed.GITHUB_PAT,
    DEPLOY_SSH_PASSPHRASE: handed.DEPLOY_SSH_PASSPHRASE,
    SENTRY_DSN: 'FakeDsnKey0123456789abcdef',
    DATABASE_URL: 'FakeDbPass0123xyz',
    SLACK_WEBHOOK_URL: 'FakeHook0123456789xyz',
  };

  for (const name of Object.keys(handed)) {
    it(`keeps ${name}'s value out of the stderr tail`, async () => {
      // The agent echoes the value with no name beside it: only the held set can know it.
      const message = await startErrorFor(`connecting with ${handed[name]} failed\n`, handed);
      expect(shows(message, bare[name]), message).toBe(false);
    });
  }

  it('keeps a handed OPENAI_API_KEY out (control, passes today)', async () => {
    const key = 'plainfakekeyvalue0123456789';
    const message = await startErrorFor(`using ${key}\n`, { OPENAI_API_KEY: key });
    expect(shows(message, key), message).toBe(false);
  });

  it("keeps the attempt's MCP token out (control, passes today)", async () => {
    const message = await startErrorFor(`mcp: bearer ${MCP_TOKEN} rejected\n`);
    expect(shows(message, MCP_TOKEN), message).toBe(false);
  });
});
