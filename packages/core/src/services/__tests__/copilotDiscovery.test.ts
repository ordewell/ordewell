import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAcpModels } from '../harness/acpModels';
import { ModelDiscovery, type AcpClientImpl, type ExecImpl } from '../ModelDiscovery';
import { COPILOT_ACP_ARGS, COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';
import { COPILOT_CLI_PROFILE } from '../harness/copilotProfile';
import type { DiscoveredModel } from '../../models/Task';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';

/**
 * Model discovery for copilot-cli against its recordings: `discovery.jsonl`
 * (signed in) and `signed-out.jsonl`, each Copilot 1.0.105's side of an
 * `initialize` and a `session/new` with no MCP server and no prompt.
 */
const FIXTURES = join(__dirname, 'fixtures/acp/copilot-cli');
const HELP_CONFIG = readFileSync(join(FIXTURES, 'help-config.txt'), 'utf8');

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-copilot-discovery-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A stand-in for `copilot --acp --stdio`: answers each request with what the recording has Copilot say next. */
function copilotReplaying(name: string): string[] {
  const entries = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { dir: string; line?: { method?: string } });
  const replies: Record<string, unknown[]> = {};
  let current = '';
  for (const entry of entries) {
    if (entry.dir === 'out' && entry.line?.method) { current = entry.line.method; replies[current] = []; }
    else if (entry.dir === 'in' && current) replies[current].push(entry.line);
  }
  const file = join(dir, 'copilot.cjs');
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

describe('copilot-cli model discovery', () => {
  it('starts Copilot as an ACP agent with the same arguments the task runner uses', () => {
    expect(COPILOT_CLI_MANIFEST.modelDiscovery.method).toBe('acp');
    expect(COPILOT_CLI_MANIFEST.modelDiscovery.acp).toEqual({ args: ['--acp', '--stdio'] });
    expect(COPILOT_CLI_PROFILE.args).toBe(COPILOT_ACP_ARGS);
  });

  it('finds no model choice in a signed-in Copilot 1.0.105 session, which offers mode and permissions only', async () => {
    expect(await discoverAcpModels(process.execPath, copilotReplaying('discovery'), { timeout: 5000 })).toEqual([]);
  });

  it('reads a signed-out Copilot (-32000) as no answer', async () => {
    expect(await discoverAcpModels(process.execPath, copilotReplaying('signed-out'), { timeout: 5000 })).toBeNull();
  });

  it('lists the models of `copilot help config` plus the auto alias when ACP offers none, signed in or out', async () => {
    for (const answer of [[] as DiscoveredModel[], null]) {
      const client: AcpClientImpl = async () => answer;
      const exec: ExecImpl = async () => ({ stdout: HELP_CONFIG });
      const registry = { getManifest: (id: string) => (id === 'copilot-cli' ? COPILOT_CLI_MANIFEST : undefined) } as unknown as RunnerRegistry;
      const models = await new ModelDiscovery(registry, exec, undefined, undefined, undefined, undefined, undefined, client).discover('copilot-cli');

      expect(models).toHaveLength(32);
      expect(models.map((m) => m.modelId)).toContain('auto');
      expect(models.every((m) => m.runnerId === 'copilot-cli')).toBe(true);
    }
  });
});
