import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session grants the page no web permission at all, the clipboard's
 * included: the terminal and Copy SHA reach the clipboard through main's
 * bridge (clipboard.ts), so nothing the page loads, nor an origin it should
 * never load, can read what the user copied through `navigator.clipboard`.
 */

type RequestHandler = (contents: unknown, permission: string, callback: (granted: boolean) => void, details: { requestingUrl: string }) => void;
type CheckHandler = (contents: unknown, permission: string, origin: string) => boolean;
type DeviceHandler = (details: unknown) => boolean;
const installed: { request?: RequestHandler; check?: CheckHandler; device?: DeviceHandler } = {};

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: {
    defaultSession: {
      webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
      setPermissionRequestHandler: (handler: RequestHandler) => { installed.request = handler; },
      setPermissionCheckHandler: (handler: CheckHandler) => { installed.check = handler; },
      setDevicePermissionHandler: (handler: DeviceHandler) => { installed.device = handler; },
    },
  },
}));

import { lockSession } from '../security';

const DEV = 'http://127.0.0.1:5173';
const ORIGINS = ['app://renderer', DEV, 'https://example.com', 'file://'];
const PERMISSIONS = ['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'media', 'geolocation', 'openExternal'];

function asked(permission: string, origin: string): Promise<boolean> {
  const request = installed.request;
  if (!request) throw new Error('lockSession installed no request handler');
  return new Promise((resolve) => request({}, permission, resolve, { requestingUrl: `${origin}/index.html` }));
}

describe('the session\'s permissions', () => {
  beforeEach(() => {
    delete installed.request;
    delete installed.check;
    delete installed.device;
  });

  it.each([undefined, DEV])('refuses every request, clipboard ones included, from every origin (dev origin %s)', async (devOrigin) => {
    lockSession(devOrigin);
    for (const origin of ORIGINS) {
      for (const permission of PERMISSIONS) await expect(asked(permission, origin)).resolves.toBe(false);
    }
  });

  it.each([undefined, DEV])('answers every check no, and every device no (dev origin %s)', (devOrigin) => {
    lockSession(devOrigin);
    for (const origin of ORIGINS) {
      for (const permission of PERMISSIONS) expect(installed.check?.({}, permission, origin)).toBe(false);
    }
    expect(installed.device?.({ deviceType: 'usb', origin: 'app://renderer' })).toBe(false);
  });
});
