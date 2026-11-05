import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import type { AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import type { RunnerManifest } from '../../plugins/types';
import { mcpClientConfig } from '../mcp';
import { fakeAcpSpawn, type FakeAcpStep } from './fakeAcpAgent';

/**
 * What an agent writes reaches Ordewell's messages through two sinks: the
 * stderr tail of a start error, and the message of a JSON-RPC error. Both
 * redact agent text, so a value under a credential name goes whatever its
 * shape; the tail is cut only after the text it is cut from was redacted.
 *
 * Fakes only: none of these keys was handed at spawn, so neither the held set
 * nor the spawn env knows them, and only the rules can.
 */
const ALNUM = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xYfake';
const BEARER = 'zX9cV7bN5mQ3wE1rT9yU7iO5pA3sD1fGfake';
const BASIC = Buffer.from('fake-user:fake-pass-1234').toString('base64');
/** Distinct base64 lines that encode nothing; `FAKEpem` marks any of them that got through. */
const BODY = Array.from({ length: 250 }, (_, i) => `FAKEpem${String(i).padStart(3, '0')}`.padEnd(64, 'QWERTYuiop0123456789+/asdfGHJKLzxcvbnm'));
const pemOf = (lines: string[]) => `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;

/** Exactly `chars` chars of whole log lines, the last of them shorter. */
function log(chars: number): string {
  const line = 'p'.repeat(99);
  const whole = Math.floor(chars / 100);
  return `${`${line}\n`.repeat(whole)}${'q'.repeat(chars - whole * 100)}`;
}

/** Any 8-char run of `secret` in `message`: a cut that kept part of a value kept one of these. */
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
  return adapter;
}
const start = (): TaskStartOptions => ({ kind: 'task', cwd: '/repo', mode: 'ask', flags: resolveTaskRunnerFlags(MANIFEST, { mode: 'ask' }), mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-fake-123-redact-then-cut' }) });

/** The start error of an agent that writes `stderr` and exits before it answers session/new. */
async function startErrorFor(stderr: string): Promise<string> {
  const adapter = setup((s) => [
    { expect: 'initialize', reply: INITIALIZED },
    { expect: 'session/new' },
    { run: (agent) => { s.processes[0].emitStderr(stderr); void agent.close(1); } },
  ]);
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

const AGENT_TEXT: [string, string, string][] = [
  ['an alphanumeric key under *_API_KEY in JSON', `Invalid configuration: {"env":{"MISTRAL_API_KEY":"${ALNUM}"}}`, ALNUM],
  ['a key of any shape under *_TOKEN', `settings: {"env":{"X_TOKEN":"${ALNUM}"}}`, ALNUM],
  ['a key under a harness login name', `settings: {"env":{"ANTHROPIC_API_KEY":"${ALNUM}"}}`, ALNUM],
  ['an assigned key', `exec: MISTRAL_API_KEY=${ALNUM} node server.js`, ALNUM],
  ['an x-api-key header', `request headers: {"x-api-key":"${ALNUM}"}`, ALNUM],
  ['a Bearer token under Authorization', `mcp: {"headers":{"Authorization":"Bearer ${BEARER}"}}`, BEARER],
  ['a Bearer token in a header line', `> Authorization: Bearer ${BEARER}`, BEARER],
  ['a Basic credential in a curl line', `curl -H "Authorization: Basic ${BASIC}" https://api.example.com/v1`, BASIC],
];

describe('agent text in a start error\'s stderr tail', () => {
  for (const [name, text, secret] of AGENT_TEXT) {
    it(`redacts ${name}`, async () => {
      const message = await startErrorFor(`${text}\n`);
      expect(shows(message, secret)).toBe(false);
      expect(message).toContain('[REDACTED');
    });
  }

  it('redacts a private key block', async () => {
    const message = await startErrorFor(`ssh: bad key\n${pemOf(BODY.slice(0, 20))}\n`);
    expect(message).not.toContain('FAKEpem');
    expect(message).toContain('-----BEGIN PRIVATE KEY-----');
    expect(message).toContain('-----END PRIVATE KEY-----');
  });

  it('redacts a private key escaped onto one line, as a service-account file holds it', async () => {
    const file = JSON.stringify({ type: 'service_account', key_material: `${pemOf(BODY.slice(0, 20))}\n`, client_email: 'x@fake-proj.iam.gserviceaccount.com' });
    const message = await startErrorFor(`config: ${file}\n`);
    expect(message).not.toContain('FAKEpem');
    expect(message).toContain('x@fake-proj.iam.gserviceaccount.com');
  });

  it('redacts the body of a key whose BEGIN line the kept text no longer holds', async () => {
    // 250 body lines are more than the raw text kept, so the BEGIN line is
    // evicted, and the END line and the lines above it are within what shows.
    const message = await startErrorFor(`ssh: bad key\n${pemOf(BODY)}\n${log(3000)}`);
    expect(message).toContain('-----END PRIVATE KEY-----');
    expect(message).not.toContain('-----BEGIN');
    expect(message).not.toContain('FAKEpem');
    expect(message).toContain('[REDACTED private key');
  });

  it('shows no part of a value wherever the 4000-char cut falls across its name and value', async () => {
    const line = `{"env":{"MISTRAL_API_KEY":"${ALNUM}"}}`;
    const redacted = `{"env":{"MISTRAL_API_KEY":"[REDACTED credential: ${ALNUM.length} chars]"}}`;
    // `into` is where a cut of the raw text would fall in the line. Redaction
    // changes the line's length before the cut is made, so the sweep runs past
    // both of its ends.
    for (let into = -8; into <= line.length + 8; into++) {
      const after = log(4000 + into - line.length - 1);
      const message = await startErrorFor(`starting\n${line}\n${after}`);
      const first = message.slice(message.indexOf('\n\n') + 2).split('\n')[0];
      expect(shows(message, ALNUM), `cut ${into} chars in`).toBe(false);
      expect(['starting', redacted, after.split('\n')[0]], `cut ${into} chars in`).toContain(first);
    }
  });
});

describe('agent text in a JSON-RPC error', () => {
  for (const [name, text, secret] of AGENT_TEXT) {
    it(`redacts ${name}`, async () => {
      const message = await refusalFor(text);
      expect(shows(message, secret)).toBe(false);
      expect(message).toContain('[REDACTED');
    });
  }

  it('redacts a private key escaped onto one line', async () => {
    const message = await refusalFor(`Invalid credentials file: ${JSON.stringify({ private_key: `${pemOf(BODY.slice(0, 20))}\n` })}`);
    expect(message).not.toContain('FAKEpem');
  });
});
