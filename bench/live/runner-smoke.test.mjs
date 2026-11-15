import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULTS, dialectOfProvider, failureDetail, loadEnvFile, minCacheableTokens } from './runner-smoke.mjs';
import { startMock } from './start-mock.mjs';

const script = path.join(import.meta.dirname, 'runner-smoke.mjs');

// Provider keys exported on the developer's machine must not turn this offline
// test into a live one, so none of them reaches the script.
const KEY = /(_API_KEY|_AUTH_TOKEN|_BASE_URL)$|^(GEMINI|GOOGLE|ANTHROPIC|OPENAI)_/;
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY.test(k)));
  return { ...env, NODE_OPTIONS: '', ...extra };
}

describe('the live smoke harness, offline', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-smoke-test-'));
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const homeEnv = { HOME: home, USERPROFILE: home };

  it('runs one task against the mock provider, passes, and leaves keyless dialects UNVERIFIED', async () => {
    const { port, child } = await startMock();
    try {
      const run = spawnSync(process.execPath, [script], {
        encoding: 'utf8', timeout: 120_000,
        env: cleanEnv({
          ...homeEnv, ORDEWELL_SMOKE_MODELS: 'openrouter:mock/ordewell-runner',
          OPENROUTER_API_KEY: 'mock-key', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
        }),
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /^PASS +chat-completions +openrouter:mock\/ordewell-runner +steps \d+ /m);
      assert.match(run.stdout, /cache ok/);
      for (const dialect of ['responses', 'anthropic-messages', 'gemini']) assert.match(run.stdout, new RegExp(`^UNVERIFIED +${dialect}`, 'm'));
    } finally { child.kill(); }
  });

  it('names the missing variable and exits non-zero when no dialect had a key', () => {
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60_000, env: cleanEnv(homeEnv) });
    assert.notEqual(run.status, 0);
    for (const [name] of [['OPENROUTER_API_KEY'], ['OPENAI_API_KEY'], ['ANTHROPIC_API_KEY'], ['GEMINI_API_KEY']]) {
      assert.match(run.stdout, new RegExp(`^UNVERIFIED .*no key: set ${name}`, 'm'));
    }
    assert.doesNotMatch(run.stdout, /^PASS/m);
    assert.match(run.stderr, /Nothing ran/);
  });

  it('fails, with the reason, when the run does not end in a pass', async () => {
    const { port, child } = await startMock();
    try {
      // The mock answers an unknown persona with prose and never calls task_complete.
      const run = spawnSync(process.execPath, [script], {
        encoding: 'utf8', timeout: 120_000,
        env: cleanEnv({
          ...homeEnv, ORDEWELL_SMOKE_MODELS: 'openrouter:mock/no-such-persona', ORDEWELL_SMOKE_TIMEOUT_MS: '60000',
          OPENROUTER_API_KEY: 'mock-key', OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`,
        }),
      });
      assert.notEqual(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /^FAIL +chat-completions/m);
      assert.match(run.stdout, /^ +log tail \(attempt 1, \d+ events\):$/m);
      assert.match(run.stderr, /FAILED:/);
    } finally { child.kill(); }
  });

  it('shows why a run failed: the runner\'s error, what waits on a person and the log\'s tail, keys redacted', () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const events = [
      { type: 'turn_start', message: 'Fix add' },
      { type: 'error', message: `404 no endpoint for ${key} (HTTP 404)` },
      { type: 'turn_end', reason: 'failed' },
    ];
    const session = {
      taskLogAttempts: () => [1],
      taskLog: (id, attempt) => (id === 't' && attempt === 1 ? events : []),
      escalations: () => [{ kind: 'input', task: { id: 't' }, reason: 'Waiting for your input. Its turn failed: 404 no endpoint' }, { kind: 'input', task: { id: 'other' }, reason: 'not this one' }],
    };
    const detail = failureDetail(session, 't');
    assert.equal(detail[0], 'runner error: 404 no endpoint for sk-or-… (HTTP 404)');
    assert.equal(detail[1], 'escalation (input): Waiting for your input. Its turn failed: 404 no endpoint');
    assert.equal(detail[2], 'log tail (attempt 1, 3 events):');
    assert.equal(detail.length, 6);
    assert.ok(detail.every((line) => !line.includes(key)));
  });

  it('keeps its tables consistent', () => {
    assert.deepEqual(DEFAULTS.map((d) => dialectOfProvider(d.model.split(':')[0])), DEFAULTS.map((d) => d.dialect));
    assert.equal(minCacheableTokens('openai', 'gpt-5-mini'), 1024);
    assert.equal(minCacheableTokens('anthropic', 'claude-haiku-5-5'), 4096);
  });

  it('reads .env without overriding what the shell exported', () => {
    const file = path.join(home, 'x.env');
    fs.writeFileSync(file, '# c\nexport A="1"\nB=\'2\'\nC=3\n');
    const env = { C: 'shell' };
    loadEnvFile(file, env);
    assert.deepEqual(env, { A: '1', B: '2', C: 'shell' });
  });
});
