import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import App from '../../test/ChatApp';
import { post } from './webview';

const KEY_TIP = 'Tip: Add an API key with /key-set to run tasks on the built-in runner.';

const composer = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('.chat-input-wrapper textarea')!;

/** Every tip the empty composer shows over one full cycle, emptied between each as a person would. */
function tipsOverACycle(): Set<string> {
  const seen = new Set<string>([composer().placeholder]);
  for (let i = 0; i < 9; i++) {
    fireEvent.change(composer(), { target: { value: 'x' } });
    fireEvent.change(composer(), { target: { value: '' } });
    seen.add(composer().placeholder);
  }
  return seen;
}

/**
 * The /key-set tip is news only to someone with no provider key, and only the
 * host knows who that is: until it has said, the tip stays out (ADR-0070).
 */
describe('the empty composer\'s /key-set tip', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('comes round once the host has said no provider is configured and no provider runner is listed', () => {
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setRunners', runners: [{ id: 'claude-code', displayName: 'Claude Code', enabled: true }] });

    expect(tipsOverACycle()).toContain(KEY_TIP);
  });

  it('stays out while the host has not said, or has said only half of it', () => {
    expect(tipsOverACycle()).not.toContain(KEY_TIP);
    post({ type: 'setRunners', runners: [] });
    expect(tipsOverACycle()).not.toContain(KEY_TIP);
  });

  it('stays out once a provider is configured', () => {
    post({ type: 'setConfiguredProviders', providers: ['openrouter'] });
    post({ type: 'setRunners', runners: [] });

    expect(tipsOverACycle()).not.toContain(KEY_TIP);
  });

  it('stays out when a provider runner is listed though the catalog has not named its provider yet', () => {
    // The desktop draws the planners from the runner list before the catalog answers, with no providers yet.
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setRunners', runners: [{ id: 'openrouter', displayName: 'OpenRouter', enabled: true }] });

    expect(tipsOverACycle()).not.toContain(KEY_TIP);
  });
});
