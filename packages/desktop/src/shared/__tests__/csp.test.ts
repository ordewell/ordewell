import { describe, expect, it } from 'vitest';
import { developmentCsp, isAllowedRendererUrl, isAppPage, productionCsp } from '../csp';

const DEV = 'http://127.0.0.1:5183';

describe('productionCsp', () => {
  it('allows no network origin and no inline script', () => {
    const csp = productionCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:/);
  });
});

describe('developmentCsp', () => {
  it('names only the dev server and its socket', () => {
    const csp = developmentCsp(DEV);
    expect(csp).toContain(`connect-src ${DEV} ws://127.0.0.1:5183`);
    expect(csp).not.toContain('127.0.0.1:3742');
  });
});

describe('isAllowedRendererUrl', () => {
  it('allows the app scheme on its own host only', () => {
    expect(isAllowedRendererUrl('app://renderer/index.html')).toBe(true);
    expect(isAllowedRendererUrl('app://elsewhere/index.html')).toBe(false);
  });

  it('allows inline data and devtools', () => {
    expect(isAllowedRendererUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedRendererUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
  });

  it('refuses the daemon, the web and local files', () => {
    expect(isAllowedRendererUrl('http://127.0.0.1:3742/api/sessions')).toBe(false);
    expect(isAllowedRendererUrl('ws://127.0.0.1:3742/ws/session/x')).toBe(false);
    expect(isAllowedRendererUrl('https://example.com/')).toBe(false);
    expect(isAllowedRendererUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRendererUrl('not a url')).toBe(false);
  });

  it('allows the dev server and its socket only when there is one', () => {
    expect(isAllowedRendererUrl(`${DEV}/src/main.tsx`, DEV)).toBe(true);
    expect(isAllowedRendererUrl('ws://127.0.0.1:5183/', DEV)).toBe(true);
    expect(isAllowedRendererUrl(`${DEV}/src/main.tsx`)).toBe(false);
    expect(isAllowedRendererUrl('http://127.0.0.1:3742/api/server', DEV)).toBe(false);
  });
});

describe('isAppPage', () => {
  it('accepts the app page, and the dev server only in dev', () => {
    expect(isAppPage('app://renderer/index.html')).toBe(true);
    expect(isAppPage(`${DEV}/index.html`, DEV)).toBe(true);
    expect(isAppPage(`${DEV}/index.html`)).toBe(false);
  });

  it('refuses any other page', () => {
    expect(isAppPage('https://example.com/')).toBe(false);
    expect(isAppPage('app://other/index.html')).toBe(false);
    expect(isAppPage('about:blank')).toBe(false);
    expect(isAppPage('')).toBe(false);
  });
});
