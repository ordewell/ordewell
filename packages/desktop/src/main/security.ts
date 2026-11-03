import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { app, protocol, session, type WebContents } from 'electron';
import { isInside } from './paths';
import { APP_HOST, APP_SCHEME, developmentCsp, isAllowedRendererUrl, productionCsp } from '../shared/csp';

/**
 * Everything ADR-0060 H4 asks of a renderer besides the bridge: one origin it
 * loads from, a policy that lets nothing out, no navigation, no new windows,
 * no permissions. Applied to the default session and to every web contents
 * the app ever creates, so a window added later cannot forget it.
 */

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/** Before `ready`: a standard, secure scheme gets an origin of its own, which `'self'` in the policy then names. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** Serves the built renderer from `app://renderer/`, with the policy as a header so no page can drop it. */
export function serveRenderer(rendererRoot: string): void {
  const root = resolve(rendererRoot);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const file = resolve(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!isInside(root, file)) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Content-Security-Policy': productionCsp(),
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** The default session's locks: requests to anywhere but the app, and every permission prompt, are refused. */
export function lockSession(devOrigin: string | undefined): void {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererUrl(details.url, devOrigin) });
  });
  if (devOrigin) {
    // Vite serves the page; the policy still rides on its response.
    const csp = developmentCsp(devOrigin);
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders, 'Content-Security-Policy': [csp] };
      callback({ responseHeaders: headers });
    });
  }
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

/** Every web contents, now and later: no navigation away, no window.open, no webview. */
export function lockWebContents(): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
