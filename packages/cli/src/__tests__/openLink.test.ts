import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { openLink, type LinkSpawn } from '../openLink';

const URL_ = 'https://github.com/ordewell/ordewell';

/** A spawn that records what it was asked to run, and starts or fails as told. */
function fakeSpawn(outcome: 'spawn' | 'error') {
  const calls: { command: string; args: readonly string[] }[] = [];
  const unref = vi.fn();
  const spawn: LinkSpawn = (command, args) => {
    calls.push({ command, args });
    const child = Object.assign(new EventEmitter(), { unref });
    queueMicrotask(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))));
    return child;
  };
  return { spawn, calls, unref };
}

describe('openLink', () => {
  it('hands the page to macOS\'s open, and lets it outlive the TUI', async () => {
    const fake = fakeSpawn('spawn');
    expect(await openLink(URL_, { platform: 'darwin', env: {}, spawn: fake.spawn })).toBe(true);
    expect(fake.calls).toEqual([{ command: 'open', args: [URL_] }]);
    expect(fake.unref).toHaveBeenCalled();
  });

  it('hands it to the URL handler on Windows, with no shell to read the address', async () => {
    const fake = fakeSpawn('spawn');
    expect(await openLink(URL_, { platform: 'win32', env: {}, spawn: fake.spawn })).toBe(true);
    expect(fake.calls).toEqual([{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', URL_] }]);
  });

  it('hands it to xdg-open on a Linux desktop', async () => {
    const fake = fakeSpawn('spawn');
    expect(await openLink(URL_, { platform: 'linux', env: { DISPLAY: ':0' }, spawn: fake.spawn })).toBe(true);
    expect(fake.calls).toEqual([{ command: 'xdg-open', args: [URL_] }]);
  });

  it('says none could be opened, and tries nothing, on a Linux terminal with no display (over SSH, say)', async () => {
    const fake = fakeSpawn('spawn');
    expect(await openLink(URL_, { platform: 'linux', env: {}, spawn: fake.spawn })).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('says none could be opened when the opener is not installed', async () => {
    const fake = fakeSpawn('error');
    expect(await openLink(URL_, { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, spawn: fake.spawn })).toBe(false);
  });
});
