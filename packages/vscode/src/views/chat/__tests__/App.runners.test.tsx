import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import App from '../App';
import { api, post } from './hostBridge';

const runnersBlock = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.setup-block')]
    .find((b) => b.querySelector('.setup-block-title')?.textContent === 'Runners');

const pill = (name: string): HTMLElement | null =>
  [...(runnersBlock()?.querySelectorAll<HTMLElement>('.runner-pill') ?? [])]
    .find((p) => p.textContent?.includes(name)) ?? null;

/** The installed list with Claude Code on, OpenCode off: what a saved choice of one runner looks like. */
function installedList(): void {
  post({
    type: 'setRunners',
    runners: [
      { id: 'claude-code', displayName: 'Claude Code', enabled: true },
      { id: 'opencode', displayName: 'OpenCode', enabled: false },
    ],
  });
}

describe('the Runners block', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('offers an installed runner that is off, in a state of its own', () => {
    installedList();

    const off = pill('OpenCode');
    expect(off).not.toBeNull();
    expect(off!.className).toContain('disabled');
    expect(off!.getAttribute('title')).toMatch(/enable/i);
    expect(runnersBlock()?.textContent).not.toContain('No coding agent detected');
  });

  it('asks the host to enable it, and shows it on at once', () => {
    installedList();
    api.postMessage.mockClear();

    fireEvent.click(pill('OpenCode')!);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setRunnerEnabled', runnerId: 'opencode', enabled: true, requestId: expect.any(String) });
    expect(pill('OpenCode')!.className).toContain('on');
  });

  it('keeps a signed-out runner\'s login in its own capsule, even while the runner is on', () => {
    post({ type: 'setRunners', runners: [{ id: 'codex', displayName: 'Codex', enabled: true }] });
    post({
      type: 'setPlannerBackends',
      backends: [{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true, auth: { state: 'signed-out', loginCommand: ['codex', 'login'] } }],
      provider: 'codex',
      runner: 'codex',
    });

    const codex = pill('Codex')!;
    const group = codex.closest('.runner-pill-group')!;
    expect(codex.className).toContain('on');
    expect(codex.className).toContain('signed-out');
    expect(codex.title).toBe('Not logged in');
    expect(group.className).toContain('signed-out');
    expect(group.querySelectorAll('button')).toHaveLength(2);
    expect(group.querySelector('.planner-auth-dot')).not.toBeNull();
    expect(group.querySelector('.runner-pill-login')?.getAttribute('aria-label')).toBe('Log in to Codex');
  });

  it('keeps a signed-out runner visibly off, and still switches it on when clicked', () => {
    post({
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true },
        { id: 'codex', displayName: 'Codex', enabled: false },
      ],
    });
    post({
      type: 'setPlannerBackends',
      backends: [
        { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true, auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] } },
        { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true, auth: { state: 'signed-out', loginCommand: ['codex', 'login'] } },
      ],
      provider: 'claude-code',
      runner: 'claude-code',
    });
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/views/chat/styles.css'), 'utf8');
    document.head.append(style);

    const on = pill('Claude Code')!;
    const off = pill('Codex')!;
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(off.getAttribute('aria-pressed')).toBe('false');
    // Auth is a flag over the on/off state, so the boundary, label and dot all
    // still say which way the runner is switched.
    expect(getComputedStyle(on.closest('.runner-pill-group')!).borderTopStyle).toBe('solid');
    expect(getComputedStyle(off.closest('.runner-pill-group')!).borderTopStyle).toBe('dashed');
    expect(getComputedStyle(on).color).not.toBe(getComputedStyle(off).color);
    expect(getComputedStyle(on.querySelector('.runner-dot')!).boxShadow).not.toBe(getComputedStyle(off.querySelector('.runner-dot')!).boxShadow);

    api.postMessage.mockClear();
    fireEvent.click(off);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setRunnerEnabled', runnerId: 'codex', enabled: true, requestId: expect.any(String) });
  });

  it('hangs the capsule rows from their top edge, so a login slot shifts no neighbour', () => {
    installedList();
    post({
      type: 'setPlannerBackends',
      backends: [{ id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true, auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] } }],
      provider: 'claude-code',
      runner: 'claude-code',
    });
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/views/chat/styles.css'), 'utf8');
    document.head.append(style);

    expect(getComputedStyle(document.querySelector('.runner-pills')!).alignItems).toBe('flex-start');
    expect(getComputedStyle(document.querySelector('.planner-backends')!).alignItems).toBe('flex-start');
  });

  it('keeps both selector bars on one line that scrolls sideways, never wrapping or growing the panel', () => {
    installedList();
    post({
      type: 'setPlannerBackends',
      backends: [{ id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true, auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] } }],
      provider: 'claude-code',
      runner: 'claude-code',
    });
    const css = readFileSync(resolve(process.cwd(), 'src/views/chat/styles.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);

    for (const selector of ['.planner-backends', '.runner-pills']) {
      const bar = getComputedStyle(document.querySelector(selector)!);
      expect(bar.flexWrap, selector).toBe('nowrap');
      expect(bar.overflowX, selector).toBe('auto');
      // Hidden, so a capsule's login-failure line never gets a vertical scroller.
      expect(bar.overflowY, selector).toBe('hidden');
      expect(bar.minWidth, selector).toMatch(/^0(px)?$/);
      expect(bar.alignItems, selector).toBe('flex-start');
    }

    // A capsule must not be squeezed to fit: the row scrolls instead.
    for (const selector of ['.planner-pill-item', '.runner-pill-item']) {
      expect(getComputedStyle(document.querySelector(selector)!).flexShrink, selector).toBe('0');
    }

    // The scrolling lives in the rows: nothing between a row and the panel body
    // may widen it, and the body itself never shows a horizontal scrollbar.
    const body = document.querySelector<HTMLElement>('.setup-panel-body')!;
    expect(getComputedStyle(body).overflowX).toBe('hidden');
    for (const selector of ['.setup-panel', '.setup-block']) {
      expect(getComputedStyle(document.querySelector(selector)!).minWidth, selector).toMatch(/^0(px)?$/);
    }
    expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
  });

  it('offers every installed runner when none is enabled, rather than claiming none is installed', () => {
    post({
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: false },
        { id: 'codex', displayName: 'Codex', enabled: false },
      ],
    });

    expect(pill('Claude Code')?.className).toContain('disabled');
    expect(pill('Codex')?.className).toContain('disabled');
    expect(runnersBlock()?.textContent).not.toContain('No coding agent detected');
  });
});
