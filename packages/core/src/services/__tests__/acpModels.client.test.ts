import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverAcpModels } from '../harness/acpModels';

/**
 * The real client against a stub ACP agent: a node script that records what it
 * is sent and answers just enough of the handshake to misbehave one way at a
 * time.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-acpmodels-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stub(body: string): string[] {
  const file = join(dir, 'stub.cjs');
  writeFileSync(file, `
const readline = require('readline');
const fs = require('fs');
const log = (value) => fs.appendFileSync(${JSON.stringify(join(dir, 'seen.jsonl'))}, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === 'initialize') return send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'stub', version: '1' } } });
  ${body}
});
`);
  return [file];
}

const seen = (): Array<Record<string, unknown>> =>
  readFileSync(join(dir, 'seen.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

const SESSION = `
  if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's', configOptions: [
    { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
    { type: 'select', id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ] } });`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('the ACP model client', () => {
  it('opens a session in an empty scratch directory with no MCP servers, sends no prompt, and removes the directory', async () => {
    const models = await discoverAcpModels(process.execPath, stub(SESSION), { timeout: 5000 });
    if (!Array.isArray(models)) expect.unreachable(`answered ${String(models)}, not a list`);

    expect(models.map((m) => [m.modelId, m.variants.map((v) => v.id)])).toEqual([['small', ['low', 'high']], ['large', []]]);
    const sent = seen();
    expect(sent.map((m) => m.method)).toEqual(['initialize', 'session/new']);
    const params = sent[1].params as { cwd: string; mcpServers: unknown[] };
    expect(params.mcpServers).toEqual([]);
    expect(existsSync(params.cwd)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['seen.jsonl', 'stub.cjs']);
  });

  it('answers signed-out for an agent that will not open a session until signed in (-32000), instead of throwing', async () => {
    const models = await discoverAcpModels(process.execPath, stub(`
      if (msg.method === 'session/new') return send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });`), { timeout: 5000 });

    expect(models).toBe('signed-out');
  });

  it('answers null at the deadline and takes the agent down', async () => {
    const started = Date.now();
    const models = await discoverAcpModels(process.execPath, stub(`
      if (msg.method === 'session/new') fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));`), { timeout: 400 });

    expect(models).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await vi.waitFor(() => { if (alive(pid)) throw new Error('still running'); });
  });

  it('answers null for a binary that is not there', async () => {
    expect(await discoverAcpModels(join(dir, 'missing-agent'), [], { timeout: 2000 })).toBeNull();
  });

  it('answers null when the agent exits before it answers', async () => {
    const models = await discoverAcpModels(process.execPath, stub(`if (msg.method === 'session/new') process.exit(1);`), { timeout: 5000 });

    expect(models).toBeNull();
  });

  it('refuses a request the agent makes of the client, granting it nothing', async () => {
    const models = await discoverAcpModels(process.execPath, stub(`
      if (msg.method === 'session/new') return send({ id: 'r1', method: 'fs/read_text_file', params: { sessionId: 's', path: '/etc/passwd' } });
      if (msg.id === 'r1') return send({ id: 2, result: { sessionId: 's', configOptions: [] } });`), { timeout: 5000 });

    expect(models).toEqual([]);
    expect(seen().find((m) => m.id === 'r1')).toMatchObject({ error: { code: -32601 } });
  });

  it('launches the agent under the environment it is given', async () => {
    const models = await discoverAcpModels(process.execPath, stub(`
      if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 's', models: { currentModelId: 'm', availableModels: [{ modelId: process.env.ACCOUNT_HOME, name: 'x' }] } } });`),
    { timeout: 5000, env: { ...process.env, ACCOUNT_HOME: '/accounts/work' } });
    if (!Array.isArray(models)) expect.unreachable(`answered ${String(models)}, not a list`);

    expect(models.map((m) => m.modelId)).toEqual(['/accounts/work']);
  });
});
