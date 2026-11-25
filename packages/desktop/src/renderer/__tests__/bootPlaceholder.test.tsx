import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, screen } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasColour } from '../../main/chrome';
import { productionCsp } from '../../shared/csp';
import type { WindowContext } from '../../shared/bridge';
import { fakeDaemon } from '../session/__tests__/fakeDaemon';
import { App } from '../App';

vi.mock('../views', () => ({ registerViews: () => () => undefined }));
vi.mock('../frame/commands', () => ({ registerFrameCommands: () => () => undefined }));
vi.mock('../Welcome', () => ({ Welcome: () => <div>Welcome ready</div> }));

/**
 * The page main loads into every window (index.html): until the app's script
 * runs, its #root holds a static placeholder, the mark and one line, so a
 * slow start shows the app starting rather than an empty window.
 */
// A path, not a URL: under jsdom the global URL is the DOM's, which node's fs does not take.
const renderer = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(renderer, 'index.html'), 'utf8');
const theme = readFileSync(join(renderer, 'theme.css'), 'utf8');
const page = new DOMParser().parseFromString(html, 'text/html');
const style = [...page.querySelectorAll('style')].map((element) => element.textContent ?? '').join('\n');

/** A token's value in theme.css's block for one scheme. */
function token(scheme: 'light' | 'dark', name: string): string {
  const block = new RegExp(`prefers-color-scheme: ${scheme}\\)\\s*\\{\\s*:root\\s*\\{([^}]*)\\}`).exec(theme)?.[1] ?? '';
  const value = new RegExp(`--ow-${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i').exec(block)?.[1];
  if (!value) throw new Error(`theme.css has no ${scheme} --ow-${name}`);
  return value.toLowerCase();
}

/** The colour a rule in the placeholder's style sets, light outside the dark query, dark inside it. */
function placeholder(scheme: 'light' | 'dark', selector: string, property: string): string | undefined {
  const [light, dark = ''] = style.split('@media (prefers-color-scheme: dark)');
  const source = scheme === 'light' ? light : dark;
  const rule = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(source ?? '')?.[1] ?? '';
  return new RegExp(`(?:^|;|\\s)${property}:\\s*(#[0-9a-f]{6})`, 'i').exec(rule)?.[1]?.toLowerCase();
}

describe('the placeholder in index.html', () => {
  it('shows the mark and says Ordewell is starting', () => {
    const root = page.getElementById('root');
    const boot = root?.querySelector('[data-boot-placeholder]');
    expect(boot).not.toBeNull();
    expect(boot?.getAttribute('role')).toBe('status');
    expect(boot?.querySelector('svg circle')).not.toBeNull();
    expect(boot?.textContent).toBe('Starting Ordewell…');
  });

  it('runs no script of its own: the policy allows only the app\'s, and styles inline', () => {
    for (const script of page.querySelectorAll('script')) {
      expect(script.getAttribute('src')).toBeTruthy();
      expect(script.textContent?.trim()).toBe('');
    }
    for (const element of page.querySelectorAll('*')) {
      expect([...element.attributes].filter((attribute) => attribute.name.startsWith('on'))).toEqual([]);
    }
    expect(productionCsp()).toContain("script-src 'self';");
    expect(productionCsp()).toContain("style-src 'self' 'unsafe-inline'");
    expect(html).not.toMatch(/javascript:/i);
  });

  it('is drawn on the window\'s own background, in the theme\'s colours, light and dark', () => {
    for (const [scheme, dark] of [['light', false], ['dark', true]] as const) {
      expect(placeholder(scheme, 'html', 'background')).toBe(canvasColour(dark));
      expect(placeholder(scheme, '.ow-boot', 'background')).toBe(canvasColour(dark));
      expect(canvasColour(dark)).toBe(token(scheme, 'bg'));
      expect(placeholder(scheme, '.ow-boot', 'color')).toBe(token(scheme, 'fg'));
      expect(placeholder(scheme, '.ow-boot-line', 'color')).toBe(token(scheme, 'fg-secondary'));
      expect(placeholder(scheme, '.ow-boot-dot', 'fill')).toBe(token(scheme, 'area-planner'));
    }
  });
});

describe('the app\'s first render', () => {
  let root: Root | undefined;
  beforeEach(() => {
    fakeDaemon();
    Object.assign(window.ordewell.app, { info: async () => ({ platform: 'darwin' }), onMenuCommand: () => () => undefined });
    Object.assign(window.ordewell, { prefs: { get: async () => ({ layouts: {} }) } });
    document.body.innerHTML = page.body.innerHTML;
    for (const script of document.body.querySelectorAll('script')) script.remove();
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
  });

  it('replaces the placeholder, as main.tsx mounts the app into #root', async () => {
    Object.assign(window.ordewell.app, { context: () => new Promise<WindowContext>(() => undefined) });
    const container = document.getElementById('root');
    if (!container) throw new Error('index.html has no #root');
    expect(screen.getByRole('status')).toHaveTextContent('Starting Ordewell…');

    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
    });
    expect(container.querySelector('[data-boot-placeholder]')).toBeNull();
    expect(screen.queryByText('Starting Ordewell…')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Opening Ordewell…');
  });
});
