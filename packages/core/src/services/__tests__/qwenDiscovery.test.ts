import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAcpModels } from '../harness/acpModels';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
import { ModelResolver } from '../ModelResolver';
import { fakeConfig } from '../../testing';
import { VENDORS } from '../apiProviders';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';
import { QWEN_ACP_ARGS, QWEN_CODE_MANIFEST } from '../../plugins/builtin/qwen.manifest';
import { QWEN_CODE_PROFILE } from '../harness/qwenProfile';
import type { DiscoveredModel } from '../../models/Task';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';

/**
 * Model discovery for qwen-code against its recordings: `discovery.jsonl`
 * (signed in) and `signed-out.jsonl`, each Qwen Code 0.26.6's side of an
 * `initialize` and a `session/new` with no MCP server and no prompt.
 */
const FIXTURES = join(__dirname, 'fixtures/acp/qwen-code');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-qwen-discovery-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** What the recording has Qwen say after each request, by method. */
function repliesOf(name: string): Record<string, unknown[]> {
  const entries = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dir: string; line?: { method?: string } });
  const replies: Record<string, unknown[]> = {};
  let current = '';
  for (const entry of entries) {
    if (entry.dir === 'out' && entry.line?.method) { current = entry.line.method; replies[current] = []; }
    else if (entry.dir === 'in' && current) replies[current].push(entry.line);
  }
  return replies;
}

/** A stand-in for `qwen --acp`: answers each request with what the recording has Qwen say next. */
function qwenReplaying(name: string): string[] {
  const file = join(dir, 'qwen.cjs');
  writeFileSync(file, `
const replies = ${JSON.stringify(repliesOf(name))};
require('readline').createInterface({ input: process.stdin }).on('line', (text) => {
  const msg = JSON.parse(text);
  for (const reply of replies[msg.method] ?? []) {
    const out = reply.id !== undefined ? { ...reply, id: msg.id } : reply;
    process.stdout.write(JSON.stringify(out) + '\\n');
  }
});
`);
  return [file];
}

/**
 * A stand-in for `qwen --acp` that signs in from its environment as Qwen Code
 * 0.26.6 does: only with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL all
 * set, when its session offers that model alone, in its runtime form (as the
 * real one did with an OpenRouter key). With any of them missing it refuses
 * `session/new` as the signed-out recording has it do.
 */
function qwenSigningInFromEnv(): string[] {
  const file = join(dir, 'qwen-env.cjs');
  writeFileSync(file, `
const env = process.env;
const signedIn = Boolean(env.OPENAI_API_KEY && env.OPENAI_BASE_URL && env.OPENAI_MODEL);
const replies = signedIn ? ${JSON.stringify(repliesOf('discovery'))} : ${JSON.stringify(repliesOf('signed-out'))};
const id = '$runtime|openai|' + env.OPENAI_MODEL + '(openai)';
require('readline').createInterface({ input: process.stdin }).on('line', (text) => {
  const msg = JSON.parse(text);
  if (signedIn && msg.method === 'session/new') {
    const result = { sessionId: 'env-session', models: { currentModelId: id, availableModels: [{ modelId: id, name: env.OPENAI_MODEL }] } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    return;
  }
  for (const reply of replies[msg.method] ?? []) {
    const out = reply.id !== undefined ? { ...reply, id: msg.id } : reply;
    process.stdout.write(JSON.stringify(out) + '\\n');
  }
});
`);
  return [file];
}

const KEY = 'sk-or-v1-saved-by-key-command';

/** The ACP client discovery would be, with the stand-in `qwen` run as the agent. */
const clientOf = (qwen: string[]): AcpClientImpl => (_command, args, options) => discoverAcpModels(process.execPath, [...qwen, ...args], { ...options, timeout: 10_000 });
const exec: ExecImpl = async () => { throw new Error('qwen has no model listing command'); };
const registry = { getManifest: (id: string) => (id === 'qwen-code' ? QWEN_CODE_MANIFEST : undefined) } as unknown as RunnerRegistry;

/** Discovery of qwen-code under `env`, its agent the stand-in `qwen` runs as. */
function discoveryOfQwen(qwen: string[], env: Record<string, string>): ModelDiscovery {
  return new ModelDiscovery(registry, exec, undefined, undefined, () => null, undefined, async () => env, clientOf(qwen));
}

describe('qwen-code model discovery', () => {
  it('starts Qwen as an ACP agent with the same arguments the task runner uses', () => {
    expect(QWEN_CODE_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(QWEN_CODE_MANIFEST.modelDiscovery.acp).toEqual({ args: ['--acp'], credentials: QWEN_CODE_PROFILE.credentials });
    expect(QWEN_CODE_PROFILE.args).toBe(QWEN_ACP_ARGS);
  });

  it('lists the models a signed-in Qwen Code 0.26.6 offers in session/new, ids as --model takes them', async () => {
    const models = await discoverAcpModels(process.execPath, qwenReplaying('discovery'), { timeout: 5000 });
    if (!Array.isArray(models)) expect.unreachable(`answered ${String(models)}, not a list`);

    expect(models.map((m) => m.modelId)).toEqual([
      'google/gemini-2.5-flash-lite(openai)',
      'openai/gpt-4o-mini(openai)',
      'openai/gpt-4.1-mini(openai)',
    ]);
  });

  it('reads a signed-out Qwen (-32000, "Authentication required") as signed out, not as an answer', async () => {
    expect(await discoverAcpModels(process.execPath, qwenReplaying('signed-out'), { timeout: 5000 })).toBe('signed-out');
  });

  it('has no command to fall back to, so an agent that offers nothing leaves the catalog empty, never a pick it cannot make', async () => {
    for (const answer of [[] as DiscoveredModel[], null, 'signed-out' as const]) {
      const client: AcpClientImpl = async () => answer;
      const exec: ExecImpl = async () => { throw new Error('qwen has no model listing command'); };
      const registry = { getManifest: (id: string) => (id === 'qwen-code' ? QWEN_CODE_MANIFEST : undefined) } as unknown as RunnerRegistry;
      const models = await new ModelDiscovery(registry, exec, undefined, undefined, undefined, undefined, undefined, client).discover('qwen-code');

      expect(models ?? []).toEqual([]);
    }
  });

  // What the user saw: a Qwen with no sign-in of its own listed nothing, even
  // with an OpenRouter key saved in Ordewell, because discovery handed it the
  // key and the endpoint but no model.
  it('lists the model Qwen signs in on from a key saved in Ordewell, which it is handed as a start is (ADR-0060, R9)', async () => {
    const models = await discoveryOfQwen(qwenSigningInFromEnv(), { OPENROUTER_API_KEY: KEY, AI_PROVIDER: 'qwen-code' }).discover('qwen-code');

    expect(models.map((m) => m.modelId)).toEqual(['$runtime|openai|qwen/qwen3.7-max(openai)']);
  });

  it('says a Qwen that lists nothing is signed out, until a key signs it in', async () => {
    const qwen = qwenSigningInFromEnv();
    const signedOut = discoveryOfQwen(qwen, { AI_PROVIDER: 'qwen-code' });
    expect(await signedOut.discover('qwen-code')).toEqual([]);
    expect(signedOut.whyUnlisted()).toEqual({ 'qwen-code': 'signed-out' });

    const signedIn = discoveryOfQwen(qwen, { OPENROUTER_API_KEY: KEY, AI_PROVIDER: 'qwen-code' });
    expect(await signedIn.discover('qwen-code')).not.toEqual([]);
    expect(signedIn.whyUnlisted()).toEqual({});
  });

  it('tells a surface why a Qwen that lists nothing does, in the words a signed-out start gets, until a saved key signs it in', async () => {
    let env: Record<string, string> = { AI_PROVIDER: 'qwen-code' };
    const resolver = new ModelResolver(registry, fakeConfig(), { execImpl: exec, env: async () => env, acpClient: clientOf(qwenSigningInFromEnv()) });

    expect(await resolver.modelsForRunners(['qwen-code'])).toEqual({ 'qwen-code': [] });
    // What the user was told when Qwen, signed out, was asked to plan.
    expect(resolver.getRunnerDiscoveryErrors()).toEqual({
      'qwen-code': 'Qwen Code is not signed in. Run /key and choose OpenRouter (or any OpenAI-compatible provider) to hand it a key, or run qwen and sign in there.',
    });

    // As the daemon does on a saved key: the variable is set, then the catalogs are forgotten.
    env = { ...env, OPENROUTER_API_KEY: KEY };
    resolver.invalidate();
    expect((await resolver.modelsForRunners(['qwen-code']))['qwen-code']?.map((m) => m.modelId)).toEqual(['$runtime|openai|qwen/qwen3.7-max(openai)']);
    expect(resolver.getRunnerDiscoveryErrors()).toEqual({});
  });

  it('reads Qwen\'s signed-out error as signed out', () => {
    expect('Authentication required: Use Qwen Code CLI to authenticate first.').toMatch(QWEN_CODE_MANIFEST.auth?.signedOut ?? /^$/);
  });
});

describe('runner ids and API vendor ids', () => {
  it('never share an id: Qwen Code is `qwen-code` because `qwen` is the DashScope vendor', () => {
    const vendors = Object.keys(VENDORS);
    expect(vendors).toContain('qwen');
    expect(QWEN_CODE_MANIFEST.name).toBe('qwen-code');
    for (const manifest of BUILTIN_MANIFESTS) expect(vendors).not.toContain(manifest.name);
  });

  it('gives every built-in runner a distinct id', () => {
    const ids = BUILTIN_MANIFESTS.map((manifest) => manifest.name);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
