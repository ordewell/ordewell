import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvent } from '../../../shared/bridge';
import { fileSystemPlacement } from '../placement';
import { TerminalChannel, type Caller } from '../TerminalChannel';
import { TerminalHost } from '../TerminalHost';
import { fakeSpawn } from './fakePty';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ow-chan-'));
  mkdirSync(join(root, 'api'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function setup(platform: NodeJS.Platform = 'darwin') {
  const fake = fakeSpawn();
  const host = new TerminalHost(fake.spawn, { set: (fn) => { fn(); return 0; }, clear: () => undefined });
  const call = vi.fn(async (routeId: string) => (
    routeId === 'sessions.get'
      ? { ok: true, data: { run: { tasks: [{ id: 't1', order: 1, isolation: { state: 'active' } }] } } }
      : { ok: true, data: { worktrees: [] } }
  ));
  const channel = new TerminalChannel({
    host,
    placement: { ...fileSystemPlacement, call },
    platform,
    home: root,
    env: async () => ({ SHELL: '/bin/zsh', PATH: '/fixed/path:/usr/bin', ELECTRON_RUN_AS_NODE: '1' }),
  });
  const sent: Array<{ id: number; event: TerminalEvent }> = [];
  const caller = (owner = 1): Caller => ({ owner, workspace: root, send: (id, event) => sent.push({ id, event }) });
  return { channel, fake, host, sent, caller };
}
const spec = (extra: Record<string, unknown> = {}) => ({ id: 1, repo: '.', scope: { kind: 'checkout' }, cols: 90, rows: 30, ...extra });

describe('TerminalChannel (ADR-0062 G11)', () => {
  it('opens the user\'s shell in the checkout with the fixed PATH and without this app\'s own variables', async () => {
    const { channel, fake, caller } = setup();
    const result = await channel.open(caller(), spec());
    expect(result).toMatchObject({ ok: true, id: 1, shell: 'zsh' });
    const call = fake.calls[0]!;
    expect(call.file).toBe('/bin/zsh');
    expect(call.args).toEqual(['-l']);
    expect(call.cols).toBe(90);
    expect(call.env.PATH).toBe('/fixed/path:/usr/bin');
    expect(call.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(call.cwd.endsWith(root.split('/').pop()!)).toBe(true);
  });

  it('opens PowerShell on Windows', async () => {
    const { channel, fake, caller } = setup('win32');
    const result = await channel.open(caller(), spec());
    expect(result).toMatchObject({ ok: true, shell: 'powershell' });
    expect(fake.calls[0]!.file).toBe('powershell.exe');
  });

  it('refuses malformed requests without starting anything', async () => {
    const { channel, fake, caller } = setup();
    for (const bad of [null, 'x', spec({ id: 0 }), spec({ id: 1.5 }), spec({ id: '1' }), spec({ cols: 0 }), spec({ rows: 'a' }), spec({ scope: { kind: 'pwn' } }), spec({ repo: '../..' })]) {
      expect((await channel.open(caller(), bad)).ok).toBe(false);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a task worktree while its task runs, and starts nothing', async () => {
    const { channel, fake, caller } = setup();
    const result = await channel.open(caller(), spec({ scope: { kind: 'task', sessionId: 's1', taskId: 't1' } }));
    expect(!result.ok && result.message).toContain('Task #1 is running');
    expect(fake.calls).toHaveLength(0);
  });

  it('reports a shell that cannot start instead of throwing', async () => {
    const { channel, caller } = setup();
    await channel.open(caller(), spec());
    const again = await channel.open(caller(), spec());
    expect(!again.ok && again.message).toMatch(/Could not start zsh/);
  });

  it('carries input, size and close to the caller\'s own terminals only', async () => {
    const { channel, fake, caller } = setup();
    await channel.open(caller(1), spec());
    channel.write(caller(2), 1, 'nope');
    channel.write(caller(1), 1, 'ls\r');
    channel.resize(caller(1), 1, 120, 40);
    expect(fake.ptys[0]!.write.mock.calls).toEqual([['ls\r']]);
    expect(fake.ptys[0]!.resize).toHaveBeenCalledWith(120, 40);
    channel.close(caller(2), 1);
    expect(fake.ptys[0]!.kill).not.toHaveBeenCalled();
    channel.close(caller(1), 1);
    expect(fake.ptys[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('streams output and the exit back, tagged with the terminal\'s number', async () => {
    const { channel, fake, sent, caller } = setup();
    await channel.open(caller(), spec({ id: 5 }));
    fake.ptys[0]!.emit('$ ');
    fake.ptys[0]!.exit(0);
    expect(sent).toEqual([
      { id: 5, event: { kind: 'data', data: '$ ' } },
      { id: 5, event: { kind: 'exit', exitCode: 0 } },
    ]);
  });

  it('kills a window\'s terminals when it goes', async () => {
    const { channel, fake, host, caller } = setup();
    await channel.open(caller(1), spec({ id: 1 }));
    await channel.open(caller(1), spec({ id: 2 }));
    host.closeOwner(1);
    expect(fake.ptys.every((pty) => pty.kill.mock.calls.length === 1)).toBe(true);
  });

  it('refuses a launcher\'s shell, and runs only its login there', async () => {
    const { channel, fake } = setup();
    const launcher = { owner: 9, send: () => undefined };
    expect((await channel.open(launcher, spec())).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect((await channel.open(launcher, spec({ login: { runner: 'codex' } }))).ok).toBe(true);
    expect(fake.calls[0]!.cwd).toBe(root);
  });

  it('runs an agent\'s login as core\'s argv, never through a shell', async () => {
    const { channel, fake, caller } = setup();
    const result = await channel.open(caller(), spec({ login: { runner: 'codex' } }));
    expect(result).toMatchObject({ ok: true, id: 1, shell: 'codex' });
    expect(fake.calls[0]!.file).toBe('codex');
    expect(fake.calls[0]!.args).toEqual(['login']);
    expect(fake.calls[0]!.cwd.endsWith(root.split('/').pop()!)).toBe(true);
  });

  it('runs a launcher\'s login in home, with no checkout to open', async () => {
    const { channel, fake } = setup();
    const result = await channel.open({ owner: 9, send: () => undefined }, spec({ login: { runner: 'codex' } }));
    expect(result).toMatchObject({ ok: true });
    expect(fake.calls[0]!.file).toBe('codex');
    expect(fake.calls[0]!.cwd).toBe(root);
  });

  it('refuses a login Ordewell has no argv for, and starts nothing', async () => {
    const { channel, fake } = setup();
    const result = await channel.open({ owner: 9, send: () => undefined }, spec({ login: { runner: 'not-a-runner' } }));
    expect(result.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});
