import { describe, expect, it, vi } from 'vitest';
import type { TerminalEvent } from '../../../shared/bridge';
import { TerminalHost, validSize, type StartOptions, type WordChannel } from '../TerminalHost';
import { fakeSpawn } from './fakePty';

function setup() {
  const fake = fakeSpawn();
  let fire: Array<() => void> = [];
  const host = new TerminalHost(fake.spawn, {
    set: (fn) => { fire.push(fn); return fire.length; },
    clear: () => undefined,
  });
  const sent: Array<{ id: number; event: TerminalEvent }> = [];
  const options = (id: number, owner = 1): StartOptions => ({
    id, owner, file: '/bin/zsh', args: ['-l'], cwd: '/w', env: { A: 'b' }, cols: 80, rows: 24,
    send: (sentId, event) => sent.push({ id: sentId, event }),
  });
  const tick = (): void => { const run = fire; fire = []; for (const fn of run) fn(); };
  return { host, fake, sent, options, tick };
}

describe('TerminalHost', () => {
  it('starts the shell where it was told to, with the environment given', () => {
    const { host, fake, options } = setup();
    host.start(options(1));
    expect(fake.calls[0]).toMatchObject({ file: '/bin/zsh', args: ['-l'], cwd: '/w', env: { A: 'b' }, cols: 80, rows: 24 });
  });

  it('sends a burst of output as one message, and the exit after it', () => {
    const { host, fake, sent, options, tick } = setup();
    host.start(options(7));
    fake.ptys[0]!.emit('he');
    fake.ptys[0]!.emit('llo');
    expect(sent).toEqual([]);
    tick();
    expect(sent).toEqual([{ id: 7, event: { kind: 'data', data: 'hello' } }]);
    fake.ptys[0]!.emit('bye');
    fake.ptys[0]!.exit(1);
    expect(sent.slice(1)).toEqual([
      { id: 7, event: { kind: 'data', data: 'bye' } },
      { id: 7, event: { kind: 'exit', exitCode: 1 } },
    ]);
    expect(host.size).toBe(0);
  });

  it('sends a very large burst at once rather than waiting', () => {
    const { host, fake, sent, options } = setup();
    host.start(options(1));
    fake.ptys[0]!.emit('x'.repeat(70_000));
    expect(sent).toHaveLength(1);
  });

  it('refuses a number that is already in use by the same window, and allows it in another', () => {
    const { host, options } = setup();
    host.start(options(1));
    expect(() => host.start(options(1))).toThrow(/in use/);
    expect(() => host.start(options(1, 2))).not.toThrow();
  });

  it('reaches a terminal only from the window that opened it', () => {
    const { host, fake, options } = setup();
    host.start(options(1, 1));
    host.write(2, 1, 'rm -rf');
    host.resize(2, 1, 10, 10);
    host.close(2, 1);
    expect(fake.ptys[0]!.write).not.toHaveBeenCalled();
    expect(fake.ptys[0]!.resize).not.toHaveBeenCalled();
    expect(fake.ptys[0]!.kill).not.toHaveBeenCalled();
    host.write(1, 1, 'ls\r');
    host.resize(1, 1, 100, 30);
    expect(fake.ptys[0]!.write).toHaveBeenCalledWith('ls\r');
    expect(fake.ptys[0]!.resize).toHaveBeenCalledWith(100, 30);
  });

  it('re-checks what a page sends', () => {
    const { host, options } = setup();
    host.start(options(1));
    expect(() => host.write(1, 1, 42)).toThrow(/text/);
    expect(() => host.resize(1, 1, 0, 24)).toThrow(/columns/);
    expect(() => host.resize(1, 1, 80.5, 24)).toThrow(/columns/);
    expect(() => host.resize(1, 1, 80, 100000)).toThrow(/columns/);
    expect(validSize('80', 24)).toBeUndefined();
  });

  it('kills a closed terminal once and forgets it', () => {
    const { host, fake, options } = setup();
    host.start(options(1));
    host.close(1, 1);
    host.close(1, 1);
    expect(fake.ptys[0]!.kill).toHaveBeenCalledTimes(1);
    expect(host.size).toBe(0);
  });

  it('kills every terminal of a window that closes, and only those', () => {
    const { host, fake, options } = setup();
    host.start(options(1, 1));
    host.start(options(2, 1));
    host.start(options(1, 2));
    host.closeOwner(1);
    expect(fake.ptys.map((pty) => pty.kill.mock.calls.length)).toEqual([1, 1, 0]);
    expect(host.size).toBe(1);
  });

  it('kills everything on quit', () => {
    const { host, fake, options } = setup();
    host.start(options(1, 1));
    host.start(options(1, 2));
    host.killAll();
    expect(fake.ptys.every((pty) => pty.kill.mock.calls.length === 1)).toBe(true);
    expect(host.size).toBe(0);
  });

  it('counts a terminal as busy only while something besides its shell is in front', () => {
    const { host, fake, options } = setup();
    host.start(options(1));
    host.start(options(2));
    const name = (file: string): string => file.split('/').pop() ?? file;
    expect(host.busy(name)).toBe(0);
    fake.ptys[0]!.process = 'vim';
    fake.ptys[1]!.process = '-zsh';
    expect(host.busy(name)).toBe(1);
  });

  it('counts one window\'s busy terminals apart from another\'s, for closing that window', () => {
    const { host, fake, options } = setup();
    host.start(options(1));
    host.start({ ...options(1), owner: 9 });
    const name = (file: string): string => file.split('/').pop() ?? file;
    fake.ptys[1]!.process = 'npm';
    expect(host.busy(name, 9)).toBe(1);
    expect(host.busy(name, options(1).owner)).toBe(0);
    expect(host.busy(name)).toBe(1);
  });

  it('lets a failing spawn through to the caller and leaves nothing behind', () => {
    const host = new TerminalHost(vi.fn(() => { throw new Error('no pty'); }));
    expect(() => host.start({ id: 1, owner: 1, file: 'x', args: [], cwd: '/', env: {}, cols: 1, rows: 1, send: vi.fn() })).toThrow('no pty');
    expect(host.size).toBe(0);
  });

  it('sends a linked shell\'s keys and chords through its word link, and closes the link with the shell (ADR-0069)', () => {
    const { host, fake, sent, options } = setup();
    let linked: (() => void) | undefined;
    const words = (): WordChannel & { [K in keyof WordChannel]: ReturnType<typeof vi.fn> } => ({
      attach: vi.fn((_pty, done: () => void) => { linked = done; }), write: vi.fn(), word: vi.fn(), dispose: vi.fn(),
    });
    const first = words();
    host.start({ ...options(1), words: first });
    expect(first.attach).toHaveBeenCalledWith(fake.ptys[0], expect.any(Function));
    linked?.();
    expect(sent).toEqual([{ id: 1, event: { kind: 'words' } }]);

    host.write(1, 1, 'ls');
    host.word(1, 1, 'left');
    host.word(2, 1, 'right');
    expect(first.write).toHaveBeenCalledWith('ls');
    expect(fake.ptys[0]!.write).not.toHaveBeenCalled();
    expect(first.word.mock.calls).toEqual([['left']]);
    expect(() => host.word(1, 1, 'up')).toThrow(/left or right/);
    expect(() => host.word(1, 1, undefined)).toThrow(/left or right/);

    host.close(1, 1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const second = words();
    host.start({ ...options(2), words: second });
    fake.ptys[1]!.exit(0);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    const third = words();
    host.start({ ...options(3), words: third });
    host.killAll();
    expect(third.dispose).toHaveBeenCalledTimes(1);
  });

  it('does nothing with the chord for a shell without a link', () => {
    const { host, fake, options } = setup();
    host.start(options(1));
    host.word(1, 1, 'left');
    expect(fake.ptys[0]!.write).not.toHaveBeenCalled();
  });
});
