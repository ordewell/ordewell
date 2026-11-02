import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { codexAccountLimitCollector } from '../codexAccountLimits';

/**
 * The real collector — RunnerProcess, CodexRpc, the deadline — against a stub
 * `app-server`: a node script that answers the account handshake from fixtures
 * and writes down every method it was asked, so a test can see that reading
 * the limits never opened a thread or a turn.
 */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ordewell-codex-limits-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

interface StubAnswers {
  account?: unknown;
  limits?: unknown;
  limitsError?: { code: number; message: string };
  /** Raw lines written when `initialized` arrives, so before `account/read` is even asked. */
  afterInitialized?: unknown[];
  /** Raw lines written when `account/read` arrives, before its answer. */
  beforeAccount?: unknown[];
  /** Raw lines written in the same write as the `account/read` answer, after it. */
  afterAccount?: unknown[];
  /** Raw lines written before the rate-limit answer. */
  before?: unknown[];
  hang?: 'initialize' | 'limits';
}

function stub(answers: StubAnswers): string {
  const file = join(dir, 'stub.cjs');
  const log = join(dir, 'methods.log');
  writeFileSync(file, `
const fs = require('fs');
const readline = require('readline');
const answers = ${JSON.stringify(answers)};
fs.writeFileSync(${JSON.stringify(join(dir, 'codex-home.txt'))}, process.env.CODEX_HOME ?? '');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, msg.method + (msg.id === undefined ? '' : '#' + msg.id) + ' ' + JSON.stringify(msg.params ?? null) + '\\n');
  if (msg.method === 'initialize') { if (answers.hang !== 'initialize') send({ id: msg.id, result: { userAgent: 'stub' } }); return; }
  if (msg.method === 'initialized') { for (const extra of answers.afterInitialized ?? []) send(extra); return; }
  if (msg.method === 'account/read') for (const extra of answers.beforeAccount ?? []) send(extra);
  if (msg.method === 'account/read') return process.stdout.write([{ id: msg.id, result: answers.account ?? { account: null, requiresOpenaiAuth: true } }, ...(answers.afterAccount ?? [])].map((v) => JSON.stringify(v) + '\\n').join(''));
  if (msg.method === 'account/rateLimits/read') {
    for (const extra of answers.before ?? []) send(extra);
    if (answers.hang === 'limits') return;
    if (answers.limitsError) return send({ id: msg.id, error: answers.limitsError });
    return send({ id: msg.id, result: answers.limits });
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'unexpected ' + msg.method } });
});
`);
  return file;
}

function methods(): string[] {
  const log = join(dir, 'methods.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

const SIGNED_IN = { account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' }, requiresOpenaiAuth: true };

function collector(answers: StubAnswers, timeoutMs = 5000) {
  return codexAccountLimitCollector({ command: process.execPath, args: [stub(answers)], timeoutMs, isInstalled: async () => true });
}

const read = (c: ReturnType<typeof collector>) => c.acquire(new AbortController().signal);

describe('the Codex account-limit collector', () => {
  it('reads the account and its limits without opening a thread or a turn, and never asks for a token refresh', async () => {
    const reading = await read(collector({
      account: SIGNED_IN,
      limits: { rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 2_000_400_000 } } },
    }));

    expect(methods()).toEqual([
      expect.stringMatching(/^initialize#1 /),
      'initialized {}',
      'account/read#2 {"refreshToken":false}',
      'account/rateLimits/read#3 {}',
    ]);
    expect(reading).toEqual({
      kind: 'limits',
      owner: expect.any(String),
      plan: 'plus',
      buckets: [{
        id: 'codex',
        windows: [
          { slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: '2033-05-18T03:33:20.000Z' },
          { slot: 'secondary', usedPercent: 61, durationMinutes: 10080, resetsAt: '2033-05-22T18:40:00.000Z' },
        ],
      }],
    });
  });

  it('keeps every bucket the per-limit map reports, ignores the legacy copy of one, and keeps a reported 0% apart from an unreported share', async () => {
    const reading = await read(collector({
      account: SIGNED_IN,
      limits: {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 99, windowDurationMins: 300 } },
        rateLimitsByLimitId: {
          'model-b': { limitId: 'model-b', limitName: 'Spark', primary: { usedPercent: 0, windowDurationMins: 60, resetsAt: null } },
          codex: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 12.5, windowDurationMins: 180 }, secondary: { usedPercent: null, windowDurationMins: 10080, resetsAt: 2_000_000_000 } },
        },
      },
    }));

    expect(reading).toMatchObject({
      kind: 'limits',
      plan: 'pro',
      buckets: [
        { id: 'codex', windows: [
          { slot: 'primary', usedPercent: 12.5, durationMinutes: 180, resetsAt: null },
          { slot: 'secondary', usedPercent: null, durationMinutes: 10080, resetsAt: '2033-05-18T03:33:20.000Z' },
        ] },
        { id: 'model-b', name: 'Spark', windows: [{ slot: 'primary', usedPercent: 0, durationMinutes: 60, resetsAt: null }] },
      ],
    });
  });

  it('reads an empty per-limit map as no buckets known, not as nothing used', async () => {
    const reading = await read(collector({ account: SIGNED_IN, limits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 50 } }, rateLimitsByLimitId: {} } }));

    expect(reading).toMatchObject({ kind: 'limits', buckets: [] });
  });

  it('says signed out, without asking for limits, when Codex holds no login', async () => {
    const reading = await read(collector({ account: { account: null, requiresOpenaiAuth: true } }));

    expect(reading).toEqual({ kind: 'signed_out' });
    expect(methods().some((m) => m.startsWith('account/rateLimits/read'))).toBe(false);
  });

  it('says unsupported for an API-key login, which has no plan windows', async () => {
    const reading = await read(collector({ account: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } }));

    expect(reading).toEqual({ kind: 'unsupported' });
  });

  it('says unsupported when this Codex does not know the method, and when it refuses the login for limits', async () => {
    expect(await read(collector({ account: SIGNED_IN, limitsError: { code: -32601, message: 'Method not found' } }))).toEqual({ kind: 'unsupported' });
    expect(await read(collector({ account: SIGNED_IN, limitsError: { code: -32600, message: 'codex account authentication required to read rate limits' } }))).toEqual({ kind: 'unsupported' });
  });

  it('calls any other refusal a failure of the same account, so the last read can stay as stale', async () => {
    const reading = await read(collector({ account: SIGNED_IN, limitsError: { code: -32603, message: 'upstream 502 with a secret token sk-123' } }));

    expect(reading).toEqual({ kind: 'failed', owner: expect.any(String) });
    expect(JSON.stringify(reading)).not.toContain('sk-123');
  });

  it('tells two workspaces of one email apart by the workspace Codex routes to', async () => {
    const limits = { rateLimits: { limitId: 'codex', primary: { usedPercent: 1 } } };
    const a = await read(collector({ account: { ...SIGNED_IN, workspaceRouting: { chatgptAccountId: 'ws-a' } }, limits }));
    const b = await read(collector({ account: { ...SIGNED_IN, workspaceRouting: { chatgptAccountId: 'ws-b' } }, limits }));

    expect(a.kind === 'limits' && b.kind === 'limits' && a.owner !== b.owner).toBe(true);
  });

  it('discards what it read when Codex says the account changed meanwhile', async () => {
    const reading = await read(collector({
      account: SIGNED_IN,
      before: [{ method: 'account/updated', params: { authMode: null } }],
      limits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 5 } } },
    }));

    expect(reading).toEqual({ kind: 'account_changed' });
    expect(methods().some((m) => m.startsWith('account/rateLimits/read'))).toBe(true);
  });

  describe('the account announcement Codex makes on its own at startup', () => {
    // What a real app-server was observed to send, on every start, while the
    // first account/read was still unanswered. Synthetic values throughout.
    const STARTUP_ANNOUNCEMENT = { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } };
    const LIMITS = { rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 2_000_400_000 } } };
    const LIMITS_READING = {
      kind: 'limits',
      owner: expect.any(String),
      plan: 'plus',
      buckets: [{
        id: 'codex',
        windows: [
          { slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: '2033-05-18T03:33:20.000Z' },
          { slot: 'secondary', usedPercent: 61, durationMinutes: 10080, resetsAt: '2033-05-22T18:40:00.000Z' },
        ],
      }],
    };

    it('still yields the limits when it arrives while account/read is unanswered', async () => {
      const reading = await read(collector({ account: SIGNED_IN, beforeAccount: [STARTUP_ANNOUNCEMENT], limits: LIMITS }));

      expect(reading).toEqual(LIMITS_READING);
    });

    it('still yields the limits when it arrives right after initialized, before account/read is asked', async () => {
      const reading = await read(collector({ account: SIGNED_IN, afterInitialized: [STARTUP_ANNOUNCEMENT], limits: LIMITS }));

      expect(reading).toEqual(LIMITS_READING);
    });

    it('does not hide a change announced later, while the limits are being read', async () => {
      const reading = await read(collector({
        account: SIGNED_IN,
        beforeAccount: [STARTUP_ANNOUNCEMENT],
        before: [{ method: 'account/updated', params: { authMode: null, planType: null } }],
        limits: LIMITS,
      }));

      expect(reading).toEqual({ kind: 'account_changed' });
    });

    it('does not take a later announcement for a non-change because its authMode and planType match the account read', async () => {
      // They carry no identity: another ChatGPT account on the same plan sends exactly this.
      const reading = await read(collector({
        account: SIGNED_IN,
        before: [{ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } }],
        limits: LIMITS,
      }));

      expect(reading).toEqual({ kind: 'account_changed' });
    });

    it('does not hide a change announced right after the account/read answer, in the same output chunk', async () => {
      const reading = await read(collector({
        account: SIGNED_IN,
        afterAccount: [{ method: 'account/updated', params: { authMode: null, planType: null } }],
        limits: LIMITS,
      }));

      expect(reading).toEqual({ kind: 'account_changed' });
    });

    it('does not take a later announcement for a non-change after a startup one with the same fields', async () => {
      const reading = await read(collector({
        account: SIGNED_IN,
        afterInitialized: [STARTUP_ANNOUNCEMENT],
        before: [STARTUP_ANNOUNCEMENT],
        limits: LIMITS,
      }));

      expect(reading).toEqual({ kind: 'account_changed' });
    });
  });

  it('asks for one more read when a sparse rate-limit update arrives during this one, without folding it in', async () => {
    const reading = await read(collector({
      account: SIGNED_IN,
      before: [{ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 80 } } } }],
      limits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 5 } } },
    }));

    expect(reading).toMatchObject({ kind: 'limits', followUp: true, buckets: [{ id: 'codex', windows: [{ usedPercent: 5 }] }] });
  });

  it('gives up at its deadline on a server that never answers, and takes the server down', async () => {
    const started = Date.now();
    // Long enough for a loaded machine to start node and answer the account read, or the owner it fails with is not known yet.
    const reading = await read(collector({ account: SIGNED_IN, hang: 'limits' }, 3000));

    expect(reading).toEqual({ kind: 'failed', owner: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('fails at once when the server exits before answering, and when it cannot be launched', async () => {
    const file = join(dir, 'exit.cjs');
    writeFileSync(file, 'process.exit(3);');
    const exited = codexAccountLimitCollector({ command: process.execPath, args: [file], timeoutMs: 5000, isInstalled: async () => true });
    const started = Date.now();
    expect(await read(exited)).toEqual({ kind: 'failed' });
    expect(Date.now() - started).toBeLessThan(2500);

    const missing = codexAccountLimitCollector({ command: join(dir, 'no-such-codex'), timeoutMs: 5000, isInstalled: async () => true });
    expect(await read(missing)).toEqual({ kind: 'failed' });
  });

  it('stops waiting as soon as it is cancelled', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = collector({ hang: 'initialize' }, 10_000).acquire(controller.signal);
    setTimeout(() => controller.abort(), 100);

    expect(await pending).toEqual({ kind: 'failed' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not wait out its deadline when it was cancelled while the server was still starting', async () => {
    const controller = new AbortController();
    const c = codexAccountLimitCollector({
      command: process.execPath, args: [stub({ hang: 'initialize' })], timeoutMs: 10_000,
      isInstalled: async () => true,
      deps: { workspaceEnv: async () => { controller.abort(); return {}; } },
    });
    const started = Date.now();

    expect(await c.acquire(controller.signal)).toEqual({ kind: 'failed' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reads the account the workspace\'s own environment chooses, as the planner and its tasks run under', async () => {
    const workspace = join(dir, 'workspace');
    mkdirSync(join(workspace, '.ordewell'), { recursive: true });
    writeFileSync(join(workspace, '.ordewell', 'env'), 'CODEX_HOME=/accounts/work-codex\n');
    const c = codexAccountLimitCollector({
      command: process.execPath,
      args: [stub({ account: SIGNED_IN, limits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } } } })],
      timeoutMs: 5000,
      isInstalled: async () => true,
      workspaceRoot: () => workspace,
    });

    expect((await read(c)).kind).toBe('limits');
    expect(readFileSync(join(dir, 'codex-home.txt'), 'utf8')).toBe('/accounts/work-codex');
  });

  it('spawns nothing for a Codex that is not installed', async () => {
    const reading = await codexAccountLimitCollector({ command: process.execPath, args: [stub({})], isInstalled: async () => false }).acquire(new AbortController().signal);

    expect(reading).toEqual({ kind: 'not_installed' });
    expect(methods()).toEqual([]);
  });
});
