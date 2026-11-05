import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAcpModels } from '../harness/acpModels';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
import { ModelResolver } from '../ModelResolver';
import { fakeConfig } from '../../testing';
import { GEMINI_ACP_ARGS, GEMINI_CLI_MANIFEST } from '../../plugins/builtin/gemini-cli.manifest';
import { GEMINI_CLI_PROFILE } from '../harness/geminiProfile';
import type { DiscoveredModel } from '../../models/Task';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeSecret } from './fakeSecret';

/**
 * Model discovery for gemini-cli against its recordings: `discovery.jsonl`
 * (signed in) and `signed-out.jsonl`, each Gemini CLI 0.66.0's side of an
 * `initialize` and a `session/new` with no MCP server and no prompt.
 */
const FIXTURES = join(__dirname, 'fixtures/acp/gemini-cli');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-gemini-discovery-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** What the recording has Gemini say after each request, by method. */
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

/** A stand-in for `gemini --acp`: answers each request with what the recording has Gemini say next. */
function geminiReplaying(name: string): string[] {
  const file = join(dir, 'gemini.cjs');
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
 * A stand-in for `gemini --acp` that signs in from its environment as Gemini
 * CLI 0.66 does when its API-key auth is selected: with `GEMINI_API_KEY` set.
 * With none it refuses `session/new` as the signed-out recording has it do.
 */
function geminiSigningInFromEnv(): string[] {
  const file = join(dir, 'gemini-env.cjs');
  writeFileSync(file, `
const signedIn = Boolean(process.env.GEMINI_API_KEY);
const replies = signedIn ? ${JSON.stringify(repliesOf('discovery'))} : ${JSON.stringify(repliesOf('signed-out'))};
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

const KEY = fakeSecret('google');

/** The ACP client discovery would be, with the stand-in `gemini` run as the agent. */
const clientOf = (gemini: string[]): AcpClientImpl => (_command, args, options) => discoverAcpModels(process.execPath, [...gemini, ...args], { ...options, timeout: 10_000 });
const exec: ExecImpl = async () => { throw new Error('gemini has no model listing command'); };
const registry = { getManifest: (id: string) => (id === 'gemini-cli' ? GEMINI_CLI_MANIFEST : undefined) } as unknown as RunnerRegistry;

/** Discovery of gemini-cli under `env`, its agent the stand-in `gemini` runs as. */
function discoveryOfGemini(gemini: string[], env: Record<string, string>): ModelDiscovery {
  return new ModelDiscovery(registry, exec, undefined, undefined, () => null, undefined, async () => env, clientOf(gemini));
}

describe('gemini-cli model discovery', () => {
  it('starts Gemini as an ACP agent with the same arguments and credential hook the task runner uses', () => {
    expect(GEMINI_CLI_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(GEMINI_CLI_MANIFEST.modelDiscovery.acp).toEqual({ args: GEMINI_ACP_ARGS, credentials: GEMINI_CLI_PROFILE.credentials });
    expect(GEMINI_CLI_PROFILE.args).toEqual([...GEMINI_ACP_ARGS, '--skip-trust']);
  });

  it('lists the models a signed-in Gemini CLI 0.66.0 offers in session/new, ids as --model takes them', async () => {
    const models = await discoverAcpModels(process.execPath, geminiReplaying('discovery'), { timeout: 5000 });
    if (!Array.isArray(models)) expect.unreachable(`answered ${String(models)}, not a list`);

    expect(models.map((m) => m.modelId)).toContain('gemini-3.8-flash');
  });

  it('lists the models Gemini offers on the Google key saved in Ordewell, which it is handed as a start is (ADR-0060, R9)', async () => {
    const models = await discoveryOfGemini(geminiSigningInFromEnv(), { GEMINI_API_KEY: KEY }).discover('gemini-cli');

    expect(models.map((m) => m.modelId)).toContain('gemini-3.8-flash');
  });

  it('says a Gemini that lists nothing is signed out, until a key signs it in', async () => {
    const gemini = geminiSigningInFromEnv();
    const signedOut = discoveryOfGemini(gemini, {});
    expect(await signedOut.discover('gemini-cli')).toEqual([]);
    expect(signedOut.whyUnlisted()).toEqual({ 'gemini-cli': 'signed-out' });

    const signedIn = discoveryOfGemini(gemini, { GEMINI_API_KEY: KEY });
    expect(await signedIn.discover('gemini-cli')).not.toEqual([]);
    expect(signedIn.whyUnlisted()).toEqual({});
  });

  it('tells a surface why a Gemini that lists nothing does, in the words a signed-out start gets, until a saved key signs it in', async () => {
    let env: Record<string, string> = {};
    const resolver = new ModelResolver(registry, fakeConfig(), { execImpl: exec, env: async () => env, acpClient: clientOf(geminiSigningInFromEnv()) });

    expect(await resolver.modelsForRunners(['gemini-cli'])).toEqual({ 'gemini-cli': [] });
    // What the user is told when Gemini, signed out, is asked to plan.
    expect(resolver.getRunnerDiscoveryErrors()).toEqual({
      'gemini-cli': 'Gemini CLI is not signed in. Run /key and choose Google Gemini to hand it a key, or run gemini and choose how it signs in.',
    });

    // As the daemon does on a saved key: the variable is set, then the catalogs are forgotten.
    env = { GEMINI_API_KEY: KEY };
    resolver.invalidate();
    expect((await resolver.modelsForRunners(['gemini-cli']))['gemini-cli']?.map((m) => m.modelId)).toContain('gemini-3.8-flash');
    expect(resolver.getRunnerDiscoveryErrors()).toEqual({});
  });

  it('has no command to fall back to, so an agent that offers nothing leaves the catalog empty, never a pick it cannot make', async () => {
    for (const answer of [[] as DiscoveredModel[], null, 'signed-out' as const]) {
      const client: AcpClientImpl = async () => answer;
      const models = await new ModelDiscovery(registry, exec, undefined, undefined, undefined, undefined, undefined, client).discover('gemini-cli');

      expect(models ?? []).toEqual([]);
    }
  });
});
