import { describe, expect, it, vi } from 'vitest';
import type { DaemonProbe, SessionLeaseRecord } from '@ordewell/core/daemon-client';
import type { DaemonCallResult, StreamEvent } from '../../../shared/bridge';
import { HolderConnections, type HolderDeps, type HolderProxy } from '../holders';

const WORKSPACE = '/w';
const OWN_PORT = 3742;
const HOLDER_PORT = 49213;
const WINDOW_A = 1;
const WINDOW_B = 2;

function record(fields: Partial<SessionLeaseRecord> = {}): SessionLeaseRecord {
  return {
    hostId: 'h1',
    pid: 48200,
    host: { kind: 'daemon', port: HOLDER_PORT, ownerPid: 48120 },
    since: '2026-11-04T10:00:00.000Z',
    heartbeatAt: '2026-11-04T10:00:00.000Z',
    runnerGroups: [],
    ...fields,
  };
}

interface FakeProxy extends HolderProxy {
  port: number;
  closers: Array<ReturnType<typeof vi.fn>>;
}

function setup(overrides: Partial<HolderDeps> = {}) {
  const holders = new Map<string, SessionLeaseRecord | null>([['s1', record()], ['s2', record()]]);
  const proxies: FakeProxy[] = [];
  const tokens = new Map<number, string>([[HOLDER_PORT, 'holder-token']]);
  const probe = vi.fn(async (_port: number): Promise<DaemonProbe> => ({ kind: 'daemon', identity: { pid: 48200, version: '0.12.3', contract: 1 } }));
  const deps: HolderDeps = {
    contract: 1,
    ownPort: () => OWN_PORT,
    readHolder: (sessionId) => holders.get(sessionId) ?? null,
    readToken: (port) => tokens.get(port),
    probe,
    connect: (port, token) => {
      const proxy: FakeProxy = {
        port,
        closers: [],
        call: vi.fn(async (): Promise<DaemonCallResult> => ({ ok: true, status: 200, data: { at: port, token: token() } })),
        stream: vi.fn((_path: string, _onEvent: (event: StreamEvent) => void) => {
          const close = vi.fn();
          proxy.closers.push(close);
          return close;
        }),
      };
      proxies.push(proxy);
      return proxy;
    },
    ...overrides,
  };
  return { connections: new HolderConnections(deps), holders, proxies, tokens, probe };
}

describe('HolderConnections.join', () => {
  it('joins the daemon the lease names, and says who it is', async () => {
    const { connections, proxies } = setup();

    const joined = await connections.join(WINDOW_A, WORKSPACE, 's1');

    expect(joined).toEqual({
      ok: true,
      holder: { port: HOLDER_PORT, pid: 48200, ownerPid: 48120, version: '0.12.3', contract: 1, since: '2026-11-04T10:00:00.000Z' },
    });
    expect(proxies.map((p) => p.port)).toEqual([HOLDER_PORT]);
  });

  it('presents the holder\'s own token, read when the call is made', async () => {
    const { connections, tokens } = setup();
    await connections.join(WINDOW_A, WORKSPACE, 's1');
    tokens.set(HOLDER_PORT, 'minted-again');

    const answer = await connections.route(WINDOW_A, 's1')?.call({ method: 'GET', path: '/api/sessions/s1' });

    expect(answer).toMatchObject({ data: { at: HOLDER_PORT, token: 'minted-again' } });
  });

  it('refuses a daemon that speaks another contract, naming both', async () => {
    const { connections, proxies } = setup({
      probe: async () => ({ kind: 'daemon', identity: { pid: 48200, version: '0.9.0', contract: 0 } }),
    });

    const joined = await connections.join(WINDOW_A, WORKSPACE, 's1');

    expect(joined).toEqual({
      ok: false,
      reason: 'mismatch',
      message: "The TUI's daemon is 0.9.0 (contract 0); this app speaks contract 1, so it can't join.",
    });
    expect(proxies).toEqual([]);
  });

  it('says a release without desktop join support cannot be joined, and how to go on', async () => {
    // 0.12.6 from main answers /api/server with only {pid, port}: no contract.
    const { connections, proxies } = setup({
      probe: async () => ({ kind: 'daemon', identity: { pid: 48200, version: '0.12.6' } }),
    });

    const joined = await connections.join(WINDOW_A, WORKSPACE, 's1');

    expect(joined).toEqual({
      ok: false,
      reason: 'mismatch',
      message: "The TUI's daemon is Ordewell 0.12.6, started by a release without desktop join support, so this app can't join it. Quit it and choose Continue here to carry the session on, or update Ordewell.",
    });
    expect(proxies).toEqual([]);
  });

  it('still says how to go on when a daemon without a contract names no version', async () => {
    const { connections } = setup({
      probe: async () => ({ kind: 'daemon', identity: { pid: 48200 } }),
    });

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toMatchObject({
      ok: false,
      reason: 'mismatch',
      message: "The TUI's daemon was started by a release without desktop join support, so this app can't join it. Quit it and choose Continue here to carry the session on, or update Ordewell.",
    });
  });

  it('refuses when there is no token to present for the holder\'s port', async () => {
    const { connections, tokens } = setup();
    tokens.clear();

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toEqual({
      ok: false, reason: 'token', message: "Can't read the token of the daemon on :49213.",
    });
  });

  it('refuses when the daemon on the port refuses the token', async () => {
    const { connections } = setup({ probe: async () => ({ kind: 'unauthorized', tokenPresented: true }) });

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toMatchObject({ ok: false, reason: 'token' });
  });

  it('refuses a daemon on the port that is not the process holding the lease', async () => {
    const { connections } = setup({ probe: async () => ({ kind: 'daemon', identity: { pid: 777, version: '0.12.3', contract: 1 } }) });

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('refuses a process on the port that cannot show it is a daemon this app speaks to', async () => {
    const { connections } = setup({ probe: async () => ({ kind: 'unverifiable' }) });

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toEqual({
      ok: false,
      reason: 'mismatch',
      message: "The TUI's daemon on :49213 can't say which Ordewell it is, likely an older version, so the app can't join it.",
    });
  });

  it('says the session is free once its holder has exited', async () => {
    const { connections, holders } = setup();
    holders.set('s1', null);

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toMatchObject({ ok: false, reason: 'free' });
  });

  it('has nothing to join for a VS Code window, which runs the session in its own process', async () => {
    const { connections, holders } = setup();
    holders.set('s1', record({ host: { kind: 'vscode' } }));

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toMatchObject({ ok: false, reason: 'vscode' });
  });

  it('cannot reach a holder that does not say how', async () => {
    const { connections, holders } = setup();
    const older = record();
    delete older.host;
    holders.set('s1', older);

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toEqual({
      ok: false, reason: 'no-host', message: "Held by an older Ordewell process (pid 48200) that doesn't say how to reach it.",
    });
  });

  it('does not join its own daemon', async () => {
    const { connections, holders, proxies } = setup();
    holders.set('s1', record({ host: { kind: 'daemon', port: OWN_PORT } }));

    expect(await connections.join(WINDOW_A, WORKSPACE, 's1')).toMatchObject({ ok: false, reason: 'own' });
    expect(proxies).toEqual([]);
  });
});

describe('HolderConnections routing and lifetime', () => {
  it('routes only the sessions a window joined, and only for that window', async () => {
    const { connections } = setup();
    await connections.join(WINDOW_A, WORKSPACE, 's1');

    expect(connections.route(WINDOW_A, 's1')).toBeDefined();
    expect(connections.route(WINDOW_A, 's2')).toBeUndefined();
    expect(connections.route(WINDOW_B, 's1')).toBeUndefined();
    expect(connections.route(WINDOW_A, undefined)).toBeUndefined();
  });

  it('shares one connection per holder daemon, and closes it when nothing uses it', async () => {
    const { connections, proxies } = setup();
    await connections.join(WINDOW_A, WORKSPACE, 's1');
    await connections.join(WINDOW_B, WORKSPACE, 's1');
    await connections.join(WINDOW_A, WORKSPACE, 's2');
    connections.route(WINDOW_A, 's1')?.stream('/ws/session/s1', () => undefined);
    expect(proxies).toHaveLength(1);

    connections.leave(WINDOW_A, 's1');
    connections.leaveAll(WINDOW_B);
    expect(proxies[0]?.closers[0]).not.toHaveBeenCalled();

    connections.leave(WINDOW_A, 's2');
    expect(proxies[0]?.closers[0]).toHaveBeenCalledOnce();
    expect(connections.route(WINDOW_A, 's2')).toBeUndefined();
  });

  it('keeps a connection per daemon when two sessions are held by two daemons', async () => {
    const { connections, holders, tokens, proxies } = setup({
      probe: async (port) => ({ kind: 'daemon', identity: { pid: port === HOLDER_PORT ? 48200 : 51000, version: '0.12.3', contract: 1 } }),
    });
    holders.set('s2', record({ pid: 51000, host: { kind: 'daemon', port: 50001 } }));
    tokens.set(50001, 'other-token');

    await connections.join(WINDOW_A, WORKSPACE, 's1');
    await connections.join(WINDOW_A, WORKSPACE, 's2');

    expect(proxies.map((p) => p.port)).toEqual([HOLDER_PORT, 50001]);
    expect((connections.route(WINDOW_A, 's2') as FakeProxy | undefined)).toBeDefined();
  });

  it('closes a joined stream the window already closed only once', async () => {
    const { connections, proxies } = setup();
    await connections.join(WINDOW_A, WORKSPACE, 's1');
    const close = connections.route(WINDOW_A, 's1')!.stream('/ws/session/s1', () => undefined);

    close();
    connections.leave(WINDOW_A, 's1');

    expect(proxies[0]?.closers[0]).toHaveBeenCalledOnce();
  });
});
