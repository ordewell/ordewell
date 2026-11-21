import { spawn as nodeSpawn } from 'child_process';

/** The slice of `spawn` the opener uses; Node's satisfies it. */
export type LinkSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; detached: true; windowsHide: true },
) => { once(event: 'spawn' | 'error', listener: () => void): unknown; unref(): void };

export interface OpenLinkOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  spawn?: LinkSpawn;
}

/**
 * Opens `url` in the person's browser with the platform's own opener, and
 * resolves to whether one started. Only a command the person typed calls
 * this (ADR-0075): nothing here opens a page on its own.
 *
 * Windows goes through the URL handler rather than `start`, so no shell reads
 * the address. A Linux terminal with no display has no browser to start, as
 * over SSH, so it is not tried there and the caller names the page instead.
 */
export function openLink(url: string, options: OpenLinkOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const opener = platform === 'darwin' ? { command: 'open', args: [url] }
    : platform === 'win32' ? { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
      : env.DISPLAY || env.WAYLAND_DISPLAY ? { command: 'xdg-open', args: [url] }
        : null;
  if (!opener) return Promise.resolve(false);
  const spawn: LinkSpawn = options.spawn ?? nodeSpawn;
  return new Promise((resolve) => {
    try {
      const child = spawn(opener.command, opener.args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        // The browser outlives the TUI that asked for it.
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
