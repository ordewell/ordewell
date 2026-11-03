/**
 * What a renderer may load (ADR-0060 H4). Pure, so the Vite dev server, main's
 * protocol handler and the tests read the same policy.
 */

/** The privileged scheme the built renderer is served from, in place of `file:`. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'renderer';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * The built app's policy. Nothing reaches the network: every daemon request
 * goes through main, so `connect-src` is `'none'`, and there is no remote
 * script, style, frame or form target.
 */
export function productionCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The dev server's policy. Vite's client injects styles and the React refresh
 * preamble inline and talks to its own socket, so this one is looser; it still
 * names only that one origin, and it is never what a built app serves.
 */
export function developmentCsp(devOrigin: string): string {
  const socket = devOrigin.replace(/^http/, 'ws');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${devOrigin}`,
    `style-src 'self' 'unsafe-inline' ${devOrigin}`,
    `img-src 'self' data: ${devOrigin}`,
    `font-src 'self' ${devOrigin}`,
    `connect-src ${devOrigin} ${socket}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Whether a renderer request may leave: the app's own scheme, the dev server
 * when there is one, and the inline `data:` images the UI draws. Everything
 * else, remote or local, is cancelled before Chromium sends it.
 */
export function isAllowedRendererUrl(url: string, devOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST;
  if (parsed.protocol === 'data:') return true;
  if (parsed.protocol === 'devtools:') return true;
  if (devOrigin) {
    const dev = new URL(devOrigin);
    const sameOrigin = parsed.host === dev.host;
    if (sameOrigin && (parsed.protocol === dev.protocol || parsed.protocol === dev.protocol.replace('http', 'ws'))) return true;
  }
  return false;
}

/** Whether a sender frame is one of this app's own pages, as an IPC handler checks before acting. */
export function isAppPage(url: string, devOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true;
  return devOrigin !== undefined && parsed.origin === new URL(devOrigin).origin;
}
