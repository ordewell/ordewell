import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from '../App';
import { api, hostBridge, post } from './hostBridge';
import type { PlannerBackend } from '@ordewell/ui/protocol';

const backends = (usable: string[]): PlannerBackend[] => [
  { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: usable.includes('claude-code') },
  { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: usable.includes('codex') },
];

const page = () => document.body.textContent ?? '';
const runnersBlock = () => [...document.querySelectorAll('.setup-block')].find((b) => b.querySelector('.setup-block-title')?.textContent === 'Runners')?.textContent ?? '';

/**
 * The first screen while the host's probe for coding agents is out: the
 * catalog can be ready before the planner backends and the runner list are,
 * and an install with an agent on it must not be told it has none meanwhile.
 */
describe('the first screen while the coding agents are detected', () => {
  beforeEach(() => {
    render(<App />);
    hostBridge();
  });

  it('says it is detecting, not that nothing can plan, before the host says who can', () => {
    post({ type: 'setConfiguredProviders', providers: [] });

    expect(document.querySelector('.get-started')).toBeNull();
    expect(page()).toContain('Detecting coding agents…');
    expect(runnersBlock()).toContain('Detecting coding agents…');
    expect(runnersBlock()).not.toContain('No coding agent detected');
  });

  // A bare "Loading…" named nothing while the host's first probe ran, which can be long (F4).
  it('names what it waits for from the first frame, before the host has answered anything', () => {
    const list = document.querySelector('.message-list') as HTMLElement;
    expect(list.textContent).toContain('Detecting coding agents…');
    expect(list.textContent).toContain('Looking for coding agents on your PATH, then asking each one whether it is signed in.');
    expect(list.textContent).not.toContain('Loading…');
  });

  it('keeps naming the probe once the catalog is in and the agents are not', () => {
    post({ type: 'setConfiguredProviders', providers: [] });
    expect((document.querySelector('.message-list') as HTMLElement).textContent)
      .toContain('Looking for coding agents on your PATH, then asking each one whether it is signed in.');
  });

  it('settles on the detected agent', () => {
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setRunners', runners: [{ id: 'claude-code', displayName: 'Claude Code', enabled: true }] });
    post({ type: 'setPlannerBackends', backends: backends(['claude-code']), provider: 'claude-code', runner: 'claude-code' });

    expect(document.querySelector('.get-started')).toBeNull();
    expect(page()).toContain('What would you like to build?');
    expect(page()).not.toContain('Detecting coding agents…');
    expect(runnersBlock()).toContain('Claude Code');
  });

  it('asks for an agent or a key once detection found nothing', () => {
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setRunners', runners: [] });
    post({ type: 'setPlannerBackends', backends: backends([]), provider: 'openrouter' });

    expect(document.querySelector('.get-started')).not.toBeNull();
    expect(page()).not.toContain('Detecting coding agents…');
    expect(runnersBlock()).toContain('No coding agent detected');
  });

  it('opens the API key wizard without preselecting a provider', () => {
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setRunners', runners: [] });
    post({ type: 'setPlannerBackends', backends: backends([]), provider: 'openrouter' });
    api.postMessage.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Add API key' }));

    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendMessage', text: '/key-set' }));
  });

  it('a configured key is enough to plan while the agents are still detected', () => {
    post({ type: 'setConfiguredProviders', providers: ['openrouter'] });

    expect(document.querySelector('.get-started')).toBeNull();
    expect(page()).toContain('What would you like to build?');
  });
});
