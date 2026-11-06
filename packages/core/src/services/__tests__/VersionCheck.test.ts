import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startVersionCheck, VERSION_CHECK_URL, type PingFetch, type VersionCheck, type VersionCheckOptions } from '../VersionCheck';

const NOTICE =
  'Ordewell checks for a new version once a day, sending its version and a random install ID that is replaced every 30 days. '
  + 'Like any server, ordewell.ai sees your IP address. '
  + 'Set ORDEWELL_NO_VERSION_CHECK=1 to turn this off. Details: https://ordewell.ai/docs#version-check';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-23T09:00:00Z');

interface Call { url: string; init: Parameters<PingFetch>[1] }

function fakeFetch(answer: () => Promise<{ status: number; text(): Promise<string> }>): { fetch: PingFetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return answer();
    },
  };
}

const reply = (status: number, body = '') => async () => ({ status, text: async () => body });

describe('VersionCheck', () => {
  let stateDir: string;
  let now: number;
  const started: VersionCheck[] = [];

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-version-check-'));
    now = T0;
  });

  afterEach(() => {
    for (const check of started.splice(0)) check.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const stateFile = () => path.join(stateDir, 'version-check.json');
  const readState = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Record<string, unknown>;

  function start(overrides: Partial<VersionCheckOptions> & { fetch: PingFetch }) {
    const notices: string[] = [];
    const updates: string[] = [];
    const check = startVersionCheck({
      version: '0.10.12',
      stateDir,
      env: {},
      now: () => now,
      onNotice: (text) => notices.push(text),
      onUpdate: (text) => updates.push(text),
      ...overrides,
    });
    started.push(check);
    return { check, notices, updates };
  }

  /** A machine that has already seen the notice and last checked `ago` ms before now. */
  function seenNotice(ago?: number) {
    fs.writeFileSync(stateFile(), JSON.stringify({
      installId: '7d5c1c8e-2f8a-4c43-9d0e-1d6f4c2a9b11',
      installIdAt: new Date(T0 - 2 * DAY).toISOString(),
      noticeShownAt: new Date(T0 - 2 * DAY).toISOString(),
      ...(ago === undefined ? {} : { lastCheckAt: new Date(now - ago).toISOString() }),
    }));
  }

  it('shows the notice on the first start, records it and sends nothing', async () => {
    const net = fakeFetch(reply(204));
    const { check, notices } = start({ fetch: net.fetch });
    await check.settled();

    expect(notices).toEqual([NOTICE]);
    expect(net.calls).toEqual([]);
    const state = readState();
    expect(state.noticeShownAt).toBe('2026-10-23T09:00:00.000Z');
    expect(state.installIdAt).toBe('2026-10-23T09:00:00.000Z');
    expect(state.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(state.lastCheckAt).toBeUndefined();
  });

  it('pings on a later start with only the version and the install ID, and records when', async () => {
    seenNotice();
    const net = fakeFetch(reply(204));
    const { check, notices, updates } = start({ fetch: net.fetch });
    await check.settled();

    expect(VERSION_CHECK_URL).toBe('https://ordewell.ai/api/v1/ping');
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe('https://ordewell.ai/api/v1/ping?v=0.10.12&id=7d5c1c8e-2f8a-4c43-9d0e-1d6f4c2a9b11');
    expect(Object.keys(net.calls[0].init).sort()).toEqual(['method', 'redirect', 'signal']);
    expect(net.calls[0].init.method).toBe('GET');
    expect(notices).toEqual([]);
    expect(updates).toEqual([]);
    expect(readState().lastCheckAt).toBe('2026-10-23T09:00:00.000Z');
  });

  it('sends nothing within a day of the last check, and pings again once the day is up', async () => {
    seenNotice(DAY - 60_000);
    const net = fakeFetch(reply(204));
    await start({ fetch: net.fetch }).check.settled();
    expect(net.calls).toEqual([]);
    expect(readState().lastCheckAt).toBe('2026-10-22T09:01:00.000Z');

    now += 60_000;
    await start({ fetch: net.fetch }).check.settled();
    expect(net.calls).toHaveLength(1);
  });

  it('counts a start that pinged as the check, so a second start the same day sends nothing', async () => {
    seenNotice();
    const net = fakeFetch(reply(204));
    await start({ fetch: net.fetch }).check.settled();
    now += DAY / 2;
    await start({ fetch: net.fetch }).check.settled();
    expect(net.calls).toHaveLength(1);
  });

  it('names a newer version in one line', async () => {
    seenNotice();
    const { check, updates } = start({ fetch: fakeFetch(reply(200, '{"latest":"0.11.0"}')).fetch });
    await check.settled();
    expect(updates).toEqual(['Ordewell 0.11.0 is out — npm i -g ordewell']);
  });

  it('names the upgrade command the caller gives, for an install npm did not make', async () => {
    seenNotice();
    const { check, updates } = start({
      fetch: fakeFetch(reply(200, '{"latest":"0.11.0"}')).fetch,
      upgradeCommand: 'brew upgrade ordewell',
    });
    await check.settled();
    expect(updates).toEqual(['Ordewell 0.11.0 is out — brew upgrade ordewell']);
  });

  it.each([
    ['the same version', '0.10.12'],
    ['an older version', '0.10.9'],
    ['the prerelease of the running version', '0.10.12-rc.1'],
    ['something that is not a version', 'latest'],
  ])('says nothing for %s', async (_, latest) => {
    seenNotice();
    const { check, updates } = start({ fetch: fakeFetch(reply(200, JSON.stringify({ latest }))).fetch });
    await check.settled();
    expect(updates).toEqual([]);
  });

  it.each([
    ['a patch', '0.10.13'],
    ['a minor compared as a number, not as text', '0.100.0'],
    ['a major', '1.0.0'],
  ])('names %s', async (_, latest) => {
    seenNotice();
    const { check, updates } = start({ fetch: fakeFetch(reply(200, JSON.stringify({ latest }))).fetch });
    await check.settled();
    expect(updates).toEqual([`Ordewell ${latest} is out — npm i -g ordewell`]);
  });

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['a fetch that throws before it returns', () => { throw new Error('boom'); }],
    ['a server error carrying a version', reply(500, '{"latest":"9.9.9"}')],
    ['a 204 carrying a version', reply(204, '{"latest":"9.9.9"}')],
    ['bad JSON', reply(200, '{"latest":')],
    ['JSON that is not an object', reply(200, 'null')],
    ['an answer without latest', reply(200, '{}')],
    ['a body that fails to read', async () => ({ status: 200, text: () => Promise.reject(new Error('reset')) })],
  ])('swallows %s', async (_, answer) => {
    seenNotice();
    const { check, updates } = start({ fetch: fakeFetch(answer as () => ReturnType<PingFetch>).fetch });
    await expect(check.settled()).resolves.toBeUndefined();
    expect(updates).toEqual([]);
    expect(readState().lastCheckAt).toBe('2026-10-23T09:00:00.000Z');
  });

  it('swallows a caller whose callbacks throw', async () => {
    const boom = () => { throw new Error('EPIPE'); };
    const net = fakeFetch(reply(200, '{"latest":"9.9.9"}'));
    expect(() => start({ fetch: net.fetch, onNotice: boom })).not.toThrow();
    now += 60_000;
    let check: VersionCheck | undefined;
    expect(() => { check = start({ fetch: net.fetch, onUpdate: boom }).check; }).not.toThrow();
    await expect(check?.settled()).resolves.toBeUndefined();
    expect(net.calls).toHaveLength(1);
  });

  it('aborts a ping that has not answered after three seconds', async () => {
    vi.useFakeTimers({ now: T0 });
    seenNotice();
    let signal: AbortSignal | undefined;
    const hung: PingFetch = (_, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    };
    const { check } = start({ fetch: hung });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(check.settled()).resolves.toBeUndefined();
  });

  describe('a process left running', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
    });

    const clock = { now: () => Date.now() };

    it('pings again a day later without being started again', async () => {
      seenNotice();
      const net = fakeFetch(reply(200, '{"latest":"0.11.0"}'));
      const { updates } = start({ fetch: net.fetch, ...clock });
      await vi.advanceTimersByTimeAsync(DAY - 60 * 60 * 1000);
      expect(net.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(net.calls).toHaveLength(2);
      expect(updates).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(DAY);
      expect(net.calls).toHaveLength(3);
    });

    it('counts a check another process made in the shared file', async () => {
      seenNotice();
      const net = fakeFetch(reply(204));
      start({ fetch: net.fetch, ...clock });
      await vi.advanceTimersByTimeAsync(DAY / 2);
      const other = readState();
      fs.writeFileSync(stateFile(), JSON.stringify({ ...other, lastCheckAt: new Date(Date.now()).toISOString() }));
      await vi.advanceTimersByTimeAsync(DAY / 2);
      expect(net.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(DAY / 2);
      expect(net.calls).toHaveLength(2);
    });

    it('never pings from the process that showed the notice', async () => {
      const net = fakeFetch(reply(204));
      const { notices } = start({ fetch: net.fetch, ...clock });
      await vi.advanceTimersByTimeAsync(3 * DAY);
      expect(notices).toEqual([NOTICE]);
      expect(net.calls).toEqual([]);
    });

    it('stops re-checking once stopped', async () => {
      seenNotice();
      const net = fakeFetch(reply(204));
      start({ fetch: net.fetch, ...clock }).check.stop();
      await vi.advanceTimersByTimeAsync(3 * DAY);
      expect(net.calls).toHaveLength(1);
    });

    it('does not keep the process alive', () => {
      seenNotice();
      const scheduled = vi.spyOn(globalThis, 'setInterval');
      start({ fetch: fakeFetch(reply(204)).fetch, ...clock });
      const timer = scheduled.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
      expect(timer?.hasRef?.()).toBe(false);
    });
  });

  describe('the state file', () => {
    it.each([
      ['is not JSON', '{"installId": "abc", '],
      ['is JSON but not an object', '[1, 2]'],
      ['holds fields of the wrong type', '{"installId": 7, "noticeShownAt": "yesterday", "lastCheckAt": true}'],
    ])('is recreated when it %s, as on a first start', async (_, content) => {
      fs.writeFileSync(stateFile(), content);
      const net = fakeFetch(reply(204));
      const { check, notices } = start({ fetch: net.fetch });
      await check.settled();
      expect(notices).toEqual([NOTICE]);
      expect(net.calls).toEqual([]);
      expect(readState()).toEqual({
        installId: expect.any(String),
        installIdAt: '2026-10-23T09:00:00.000Z',
        noticeShownAt: '2026-10-23T09:00:00.000Z',
      });
    });

    it.each([
      ['no install ID', {}],
      ['an install ID of the wrong type', { installId: 7 }],
      ['an empty install ID', { installId: '' }],
      ['no install ID and a check an hour ago', { lastCheckAt: new Date(T0 - 60 * 60_000).toISOString() }],
    ])('starts over when it has a notice but %s, so the check is not off for good', async (_, broken) => {
      fs.writeFileSync(stateFile(), JSON.stringify({ noticeShownAt: new Date(T0 - 2 * DAY).toISOString(), ...broken }));
      const net = fakeFetch(reply(204));
      const first = start({ fetch: net.fetch });
      await first.check.settled();
      expect(first.notices).toEqual([NOTICE]);
      expect(net.calls).toEqual([]);
      const { installId } = readState();
      expect(installId).toMatch(/^[0-9a-f-]{36}$/);

      now += 60_000;
      await start({ fetch: net.fetch }).check.settled();
      expect(net.calls.map((call) => call.url)).toEqual([`${VERSION_CHECK_URL}?v=0.10.12&id=${installId}`]);
    });

    it('dates a new install ID now even when the old file kept only a minting time', async () => {
      fs.writeFileSync(stateFile(), JSON.stringify({
        installIdAt: new Date(T0 - 90 * DAY).toISOString(),
        noticeShownAt: new Date(T0 - 90 * DAY).toISOString(),
      }));
      const { check, notices } = start({ fetch: fakeFetch(reply(204)).fetch });
      await check.settled();
      expect(notices).toEqual([NOTICE]);
      const state = readState();
      expect(state.installId).toMatch(/^[0-9a-f-]{36}$/);
      expect(state.installIdAt).toBe('2026-10-23T09:00:00.000Z');
    });

    it('is created with its directory', async () => {
      const nested = path.join(stateDir, 'not', 'yet');
      const { notices } = start({ fetch: fakeFetch(reply(204)).fetch, stateDir: nested });
      expect(notices).toEqual([NOTICE]);
      expect(fs.existsSync(path.join(nested, 'version-check.json'))).toBe(true);
    });

    it('keeps the install ID across checks', async () => {
      const net = fakeFetch(reply(204));
      start({ fetch: net.fetch });
      const { installId } = readState();
      now += 60_000;
      await start({ fetch: net.fetch }).check.settled();
      expect(net.calls[0].url).toContain(`&id=${installId}`);
      expect(readState().installId).toBe(installId);
    });

    const OLD_ID = '7d5c1c8e-2f8a-4c43-9d0e-1d6f4c2a9b11';

    function agedState(installIdAt: string | undefined) {
      fs.writeFileSync(stateFile(), JSON.stringify({
        installId: OLD_ID,
        ...(installIdAt === undefined ? {} : { installIdAt }),
        noticeShownAt: new Date(T0 - 40 * DAY).toISOString(),
      }));
    }

    it('keeps an install ID that is one minute short of 30 days', async () => {
      agedState(new Date(T0 - 30 * DAY + 60_000).toISOString());
      const net = fakeFetch(reply(204));
      const { check, notices } = start({ fetch: net.fetch });
      await check.settled();
      expect(notices).toEqual([]);
      expect(readState().installId).toBe(OLD_ID);
      expect(net.calls.map((call) => call.url)).toEqual([`${VERSION_CHECK_URL}?v=0.10.12&id=${OLD_ID}`]);
    });

    it('replaces an install ID at 30 days without showing the notice again', async () => {
      agedState(new Date(T0 - 30 * DAY).toISOString());
      const net = fakeFetch(reply(204));
      const { check, notices } = start({ fetch: net.fetch });
      await check.settled();
      expect(notices).toEqual([]);
      const state = readState();
      expect(state.installId).not.toBe(OLD_ID);
      expect(state.installIdAt).toBe('2026-10-23T09:00:00.000Z');
      expect(state.noticeShownAt).toBe(new Date(T0 - 40 * DAY).toISOString());
      expect(net.calls.map((call) => call.url)).toEqual([`${VERSION_CHECK_URL}?v=0.10.12&id=${state.installId}`]);
    });

    it.each([
      ['no recorded age', undefined],
      ['a timestamp in the future', new Date(T0 + DAY).toISOString()],
    ])('replaces an install ID with %s, so an unknown age cannot last for good', async (_, installIdAt) => {
      agedState(installIdAt);
      const net = fakeFetch(reply(204));
      const { check, notices } = start({ fetch: net.fetch });
      await check.settled();
      expect(notices).toEqual([]);
      expect(readState().installId).not.toBe(OLD_ID);
      expect(net.calls).toHaveLength(1);
    });

    // POSIX permissions: Windows ignores the chmod.
    it.skipIf(process.platform === 'win32')('never pings when it cannot be written, since nothing would stop the next start pinging too', async () => {
      seenNotice();
      fs.chmodSync(stateDir, 0o500);
      try {
        const net = fakeFetch(reply(204));
        await start({ fetch: net.fetch }).check.settled();
        expect(net.calls).toEqual([]);
      } finally {
        fs.chmodSync(stateDir, 0o700);
      }
    });

    // POSIX permissions: Windows ignores the chmod.
    it.skipIf(process.platform === 'win32')('shows no notice when it cannot record one, since every start would show it again', async () => {
      fs.chmodSync(stateDir, 0o500);
      try {
        const net = fakeFetch(reply(204));
        const first = start({ fetch: net.fetch });
        const second = start({ fetch: net.fetch });
        await Promise.all([first.check.settled(), second.check.settled()]);
        expect([...first.notices, ...second.notices]).toEqual([]);
        expect(net.calls).toEqual([]);
      } finally {
        fs.chmodSync(stateDir, 0o700);
      }
    });

    it('does not throw when the state directory is a file', async () => {
      const notADir = path.join(stateDir, 'file');
      fs.writeFileSync(notADir, '');
      const net = fakeFetch(reply(204));
      const { check } = start({ fetch: net.fetch, stateDir: notADir });
      await check.settled();
      expect(net.calls).toEqual([]);
    });
  });

  describe('off', () => {
    it.each([
      ['ORDEWELL_NO_VERSION_CHECK=1', { env: { ORDEWELL_NO_VERSION_CHECK: '1' } }],
      ['ORDEWELL_NO_VERSION_CHECK=true', { env: { ORDEWELL_NO_VERSION_CHECK: 'true' } }],
      ['ORDEWELL_NO_VERSION_CHECK=YES', { env: { ORDEWELL_NO_VERSION_CHECK: 'YES' } }],
      ['DO_NOT_TRACK=1', { env: { DO_NOT_TRACK: '1' } }],
      ['DO_NOT_TRACK=true', { env: { DO_NOT_TRACK: 'true' } }],
      ['telemetryEnabled: false', { telemetryEnabled: false }],
    ])('%s: no notice, no file, no request', async (_, off) => {
      const net = fakeFetch(reply(200, '{"latest":"9.9.9"}'));
      const { check, notices, updates } = start({ fetch: net.fetch, ...off });
      await check.settled();
      expect(notices).toEqual([]);
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(net.calls).toEqual([]);
      expect(updates).toEqual([]);
    });

    it('sends nothing and rewrites nothing for a machine that had already seen the notice', async () => {
      seenNotice();
      const before = fs.readFileSync(stateFile(), 'utf8');
      const net = fakeFetch(reply(204));
      await start({ fetch: net.fetch, env: { ORDEWELL_NO_VERSION_CHECK: '1' } }).check.settled();
      expect(net.calls).toEqual([]);
      expect(fs.readFileSync(stateFile(), 'utf8')).toBe(before);
    });

    it.each(['0', 'false', 'no', ''])('stays on for ORDEWELL_NO_VERSION_CHECK=%j and DO_NOT_TRACK=%j', async (value) => {
      const { notices } = start({ fetch: fakeFetch(reply(204)).fetch, env: { ORDEWELL_NO_VERSION_CHECK: value, DO_NOT_TRACK: value } });
      expect(notices).toEqual([NOTICE]);
    });
  });

  it('names a release newer than the running prerelease of it', async () => {
    seenNotice();
    const { check, updates } = start({ version: '0.11.0-beta.2', fetch: fakeFetch(reply(200, '{"latest":"0.11.0"}')).fetch });
    await check.settled();
    expect(updates).toEqual(['Ordewell 0.11.0 is out — npm i -g ordewell']);
  });
});
