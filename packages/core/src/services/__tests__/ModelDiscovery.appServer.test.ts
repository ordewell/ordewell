import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultAppServerClient } from '../ModelDiscovery';

/**
 * The real client against a stub `app-server`: a node script that speaks
 * just enough of the JSON-RPC handshake to misbehave in one way at a time.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-appserver-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stub(body: string): string {
  const file = join(dir, 'stub.cjs');
  writeFileSync(file, `
const readline = require('readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
${body}
`);
  return file;
}

describe('the app-server model client', () => {
  it('keeps a multibyte character that arrives split across two reads', async () => {
    const script = stub(`
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) return send({ id: 1, result: {} });
  const bytes = Buffer.from(JSON.stringify({ id: 2, result: { data: [{ id: 'gpt-x', displayName: '日本語モデル' }] } }) + '\\n');
  const cut = bytes.indexOf(Buffer.from('本')) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
});`);

    const models = await defaultAppServerClient(process.execPath, [script], { timeout: 5000 });

    expect(models?.map((m) => m.displayName)).toEqual(['日本語モデル']);
  });

  it('launches the server under the environment it is given', async () => {
    const script = stub(`
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) return send({ id: 1, result: {} });
  send({ id: 2, result: { data: [{ id: process.env.CODEX_HOME }] } });
});`);

    const models = await defaultAppServerClient(process.execPath, [script], { timeout: 5000, env: { ...process.env, CODEX_HOME: '/accounts/work/codex' } });

    expect(models?.map((m) => m.id)).toEqual(['/accounts/work/codex']);
  });

  // Not on Windows: libuv never closes fds 0-2 there, so a Node stub cannot
  // close its input and the write that should meet EPIPE never fails.
  it.skipIf(process.platform === 'win32')('answers null, instead of crashing the host, when the server stops reading its input', async () => {
    const script = stub(`
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== 1) return;
  process.stdin.destroy();
  try { require('fs').closeSync(0); } catch {}
  setTimeout(() => send({ id: 1, result: {} }), 50);
  setInterval(() => {}, 1000);
});`);
    const crashes: unknown[] = [];
    const onCrash = (err: unknown) => { crashes.push(err); };
    process.on('uncaughtException', onCrash);
    try {
      const started = Date.now();
      const models = await defaultAppServerClient(process.execPath, [script], { timeout: 5000 });
      const took = Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(models).toBeNull();
      expect(took).toBeLessThan(2500);
      expect(crashes).toEqual([]);
    } finally {
      process.off('uncaughtException', onCrash);
    }
  });

  it.skipIf(process.platform === 'win32')('takes down what the server started along with it', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const script = stub(`
const { spawn } = require('child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) send({ id: 1, result: {} });
  else send({ id: 2, result: { data: [] } });
});`);

    await defaultAppServerClient(process.execPath, [script], { timeout: 5000 });
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));

    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(alive, { timeout: 5000 }).toBe(false);
  });

  it('reports no models, instead of crashing, when the server exits before answering', async () => {
    const script = stub('process.exit(3);');
    const started = Date.now();

    const models = await defaultAppServerClient(process.execPath, [script], { timeout: 5000 });

    expect(models).toBeNull();
    // The exit ends the wait at once; waiting out the deadline would be a stall.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('gives up at the deadline when the server never answers model/list', async () => {
    const script = stub(`
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === 1) send({ id: 1, result: {} });
  // model/list is never answered: a hung server, not a dead one.
});`);
    const started = Date.now();

    const models = await defaultAppServerClient(process.execPath, [script], { timeout: 400 });

    expect(models).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
