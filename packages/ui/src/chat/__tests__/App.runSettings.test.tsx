import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import App from '../../test/ChatApp';
import { post as send } from './webview';

const t1 = {
  id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
  status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
  taskMode: 'build',
};
const plan = {
  tasks: [t1], generatedAt: new Date().toISOString(), status: 'draft' as const,
  runners: ['claude-code'], lastUpdated: new Date().toISOString(),
};
const bar = () => document.querySelector('.plan-dock-bar')!.textContent!;

/** Run settings are the user's, changed by chat commands and shown wherever a run is (ADR-0030). */
describe('run settings in the chat', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('lists them on the empty chat, with the commands that change them', () => {
    send({ type: 'setConfiguredProviders', providers: ['openrouter'] });
    send({ type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' } });

    const setup = document.querySelector('.empty-state-setup')!.textContent!;
    expect(setup).toMatch(/Autonomy\s*Full\s*\/settings/);
    expect(setup).toMatch(/Run\s*supervisor Act · auto-merge off · autorun off\s*\/settings/);
  });

  it('shows them on the plan bar, and the run\'s own level where it differs', () => {
    send({ type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', mergeAtGatesAutomatically: true } });
    send({ type: 'planUpdated', plan });
    expect(bar()).toContain('Supervisor: Act');
    expect(bar()).toContain('Merge automatically');

    send({ type: 'planUpdated', plan: { ...plan, status: 'running', runSettings: { mergeAtGatesAutomatically: true, supervisorLevel: 'watch' } } });
    expect(bar()).toContain('Supervisor: Act → Watch');

    send({ type: 'planUpdated', plan: { ...plan, status: 'running', runSettings: { mergeAtGatesAutomatically: true, supervisorLevel: 'act', unsupervised: 'its wake-up turn failed twice' } } });
    expect(bar()).toContain('Supervisor: Act → unsupervised');
  });

  it('has no controls for them on the plan: they are chat commands', () => {
    send({ type: 'planUpdated', plan });

    expect(screen.queryByRole('checkbox', { name: /Merge automatically/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Supervisor/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drop to Watch' })).toBeNull();
  });

  for (const autorun of [false, true]) {
    it(`waits for host settings on GetStarted and preserves autorun=${autorun} when planning becomes available`, () => {
      send({ type: 'setConfiguredProviders', providers: [] });
      // Detection found no coding agent.
      send({ type: 'setPlannerBackends', backends: [{ id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: false }], provider: 'openrouter' });
      expect(document.querySelector('.get-started')).not.toBeNull();
      expect(document.body.textContent).not.toContain('Nothing runs until');
      expect(document.body.textContent).not.toContain('Autorun is on');

      send({ type: 'setRunSettings', autonomous: false, run: { ...RUN_SETTINGS_DEFAULTS, autorun } });
      const note = autorun ? 'Autorun is on' : 'Nothing runs until you approve the plan.';
      expect(document.querySelector('.get-started')?.textContent).toContain(note);
      send({ type: 'setConfiguredProviders', providers: ['openrouter'] });
      expect(document.querySelector('.get-started')).toBeNull();
      expect(document.querySelector('.empty-state')?.textContent).toContain(note);
      if (autorun) expect(document.body.textContent).not.toContain('Nothing runs until');
    });
  }
});
