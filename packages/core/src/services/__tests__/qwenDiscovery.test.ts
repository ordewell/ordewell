import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAcpModels } from '../harness/acpModels';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
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

/** A stand-in for `qwen --acp`: answers each request with what the recording has Qwen say next. */
function qwenReplaying(name: string): string[] {
  const entries = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dir: string; line?: { method?: string } });
  const replies: Record<string, unknown[]> = {};
  let current = '';
  for (const entry of entries) {
    if (entry.dir === 'out' && entry.line?.method) { current = entry.line.method; replies[current] = []; }
    else if (entry.dir === 'in' && current) replies[current].push(entry.line);
  }
  const file = join(dir, 'qwen.cjs');
  writeFileSync(file, `
const replies = ${JSON.stringify(replies)};
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

describe('qwen-code model discovery', () => {
  it('starts Qwen as an ACP agent with the same arguments the task runner uses', () => {
    expect(QWEN_CODE_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(QWEN_CODE_MANIFEST.modelDiscovery.acp).toEqual({ args: ['--acp'] });
    expect(QWEN_CODE_PROFILE.args).toBe(QWEN_ACP_ARGS);
  });

  it('lists the models a signed-in Qwen Code 0.26.6 offers in session/new, ids as --model takes them', async () => {
    const models = await discoverAcpModels(process.execPath, qwenReplaying('discovery'), { timeout: 5000 });

    expect(models?.map((m) => m.modelId)).toEqual([
      'google/gemini-2.5-flash-lite(openai)',
      'openai/gpt-4o-mini(openai)',
      'openai/gpt-4.1-mini(openai)',
    ]);
  });

  it('reads a signed-out Qwen (-32000, "Authentication required") as no answer', async () => {
    expect(await discoverAcpModels(process.execPath, qwenReplaying('signed-out'), { timeout: 5000 })).toBeNull();
  });

  it('has no command to fall back to, so an agent that offers nothing leaves the catalog empty, never a pick it cannot make', async () => {
    for (const answer of [[] as DiscoveredModel[], null]) {
      const client: AcpClientImpl = async () => answer;
      const exec: ExecImpl = async () => { throw new Error('qwen has no model listing command'); };
      const registry = { getManifest: (id: string) => (id === 'qwen-code' ? QWEN_CODE_MANIFEST : undefined) } as unknown as RunnerRegistry;
      const models = await new ModelDiscovery(registry, exec, undefined, undefined, undefined, undefined, undefined, client).discover('qwen-code');

      expect(models ?? []).toEqual([]);
    }
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
