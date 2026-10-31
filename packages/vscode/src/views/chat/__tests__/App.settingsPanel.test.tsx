import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '@ordewell/core';
import App from '../App';
import { api, post as send } from './hostBridge';

const settings = (run: Partial<GlobalRunSettings> = {}, extra: { autonomous?: boolean; maxParallel?: number } = {}) => send({
  type: 'setRunSettings',
  autonomous: extra.autonomous ?? true,
  run: { ...RUN_SETTINGS_DEFAULTS, ...run },
  maxParallel: extra.maxParallel ?? 5,
});
const runToggle = () => screen.getByRole('button', { name: 'Run' });
const row = (name: string) => within(screen.getByRole('group', { name }));

/** The Run block of the Settings panel: each click saves one setting through the host (ADR-0030). */
describe('run settings in the Settings panel', () => {
  beforeEach(() => {
    render(<App />);
    settings();
    fireEvent.click(runToggle());
    api.postMessage.mockClear();
  });

  it('starts collapsed with a summary of the current values and no rows', () => {
    cleanup();
    render(<App />);
    settings({ supervisorLevel: 'act', mergeAtGatesAutomatically: true, autorun: false }, { maxParallel: 3 });
    expect(runToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Full · Supervisor: Act · Automerge on · Autorun off · 3 parallel')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Autonomy' })).toBeNull();
    fireEvent.click(runToggle());
    expect(runToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Autonomy' })).toBeInTheDocument();
    expect(screen.queryByText(/· 3 parallel/)).toBeNull();
  });

  it('draws each Run row as one segmented control, with its options in order', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/views/chat/styles.css'), 'utf8');
    document.head.append(style);

    for (const name of ['Autonomy', 'Supervisor', 'Automerge', 'Autorun']) {
      const group = screen.getByRole('group', { name });
      expect(group.className).toContain('run-setting-pills');
      expect(getComputedStyle(group).borderTopWidth).toBe('1px');
      const options = within(group).getAllByRole('button');
      expect(options.length).toBeGreaterThan(1);
      for (const [i, option] of options.entries()) {
        // The group owns the border, and each divider belongs to the option
        // after the first, so a segment is one click target.
        expect(option.parentElement).toBe(group);
        expect(getComputedStyle(option).borderLeftWidth).toBe(i === 0 ? '0px' : '1px');
      }
    }

    const supervisor = screen.getByRole('group', { name: 'Supervisor' });
    expect(within(supervisor).getByRole('button', { name: 'Watch' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves the Planned-with line to `ordewell trailer` and settings.json', () => {
    expect(screen.queryByText(/Planned-with/)).toBeNull();
  });

  it('keeps the Settings toggle outside the scrolling body', () => {
    const toggle = screen.getByRole('button', { name: /^Settings/ });
    expect(toggle.closest('.setup-panel-body')).toBeNull();
  });

  it('reports the Settings panel as expanded only while its body is shown', () => {
    const toggle = screen.getByRole('button', { name: /^Settings/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveClass('open');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveClass('open');
    expect(document.querySelector('.setup-panel-body')).toHaveClass('collapsed');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveClass('open');
  });

  it.each([
    ['Autonomy', 'Guarded', { autonomous: false }],
    ['Supervisor', 'Off', { run: { supervisorLevel: 'off' } }],
    ['Supervisor', 'Act', { run: { supervisorLevel: 'act' } }],
    ['Automerge', 'On', { run: { mergeAtGatesAutomatically: true } }],
    ['Autorun', 'On', { run: { autorun: true } }],
  ])('%s → %s posts %j', (name, label, change) => {
    fireEvent.click(row(name).getByRole('button', { name: label }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change });
  });

  it('marks the current value and posts nothing when it is clicked again', () => {
    expect(row('Supervisor').getByRole('button', { name: 'Watch' })).toHaveAttribute('aria-pressed', 'true');
    expect(row('Automerge').getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(row('Supervisor').getByRole('button', { name: 'Watch' }));
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('says which Run choices follow this session and which are machine-wide', () => {
    const block = screen.getByRole('region', { name: 'Run' });

    expect(block).toHaveTextContent(/apply to this session; your last change is the default for new ones\./);
    expect(block).toHaveTextContent(/Autonomy and Parallel tasks apply to every session\./);
  });

  it('sets delegation\'s budget as a number, off at 0', () => {
    const budget = screen.getByRole('spinbutton', { name: 'Delegation budget' });
    expect(budget).toHaveValue(0);
    fireEvent.change(budget, { target: { value: '5000000' } });
    fireEvent.keyDown(budget, { key: 'Enter' });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change: { run: { delegationTokens: 5000000 } } });
  });

  it('a number commits on Enter, any whole number at or above its floor', () => {
    const parallel = screen.getByRole('spinbutton', { name: 'Parallel tasks' });
    expect(parallel).toHaveValue(5);
    fireEvent.change(parallel, { target: { value: '17' } });
    expect(api.postMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(parallel, { key: 'Enter' });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change: { maxParallel: 17 } });
  });

  it('a number commits on blur too', () => {
    const retries = screen.getByRole('spinbutton', { name: 'Supervisor retries' });
    fireEvent.change(retries, { target: { value: '0' } });
    fireEvent.blur(retries);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change: { run: { supervisorRetryLimit: 0 } } });
  });

  it.each([
    ['Parallel tasks', '0'],
    ['Supervisor retries', '-1'],
    ['Parallel tasks', '2.5'],
    ['Parallel tasks', ''],
  ])('%s refuses %j: marked invalid, never sent', (name, typed) => {
    const input = screen.getByRole('spinbutton', { name });
    fireEvent.change(input, { target: { value: typed } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('shows the host\'s value again when the host answers, whatever was typed', () => {
    const parallel = screen.getByRole('spinbutton', { name: 'Parallel tasks' });
    fireEvent.change(parallel, { target: { value: '0' } });
    settings({}, { maxParallel: 8 });
    expect(parallel).toHaveValue(8);
    expect(parallel).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('never offers a Supervisor reads row, at Off, Watch or Act', () => {
    for (const supervisorLevel of ['off', 'watch', 'act'] as const) {
      settings({ supervisorLevel });
      expect(screen.queryByRole('spinbutton', { name: 'Supervisor reads' })).toBeNull();
      expect(screen.queryByText('Supervisor reads')).toBeNull();
    }
  });

  it('keeps Supervisor retries and the rest when the level changes with the panel open, and never brings reads back', () => {
    settings({ supervisorLevel: 'act' });
    expect(screen.getByRole('spinbutton', { name: 'Supervisor retries' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor reads' })).toBeNull();

    settings({ supervisorLevel: 'off' });
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor retries' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor reads' })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Parallel tasks' })).toBeInTheDocument();

    settings({ supervisorLevel: 'watch' });
    expect(screen.getByRole('spinbutton', { name: 'Supervisor retries' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor reads' })).toBeNull();
  });

  it('saves another setting without mentioning a manually configured read budget', () => {
    settings({ supervisorLevel: 'watch', wakeUpReadBudget: 30 });
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor reads' })).toBeNull();

    fireEvent.click(row('Supervisor').getByRole('button', { name: 'Off' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change: { run: { supervisorLevel: 'off' } } });
    expect(api.postMessage).not.toHaveBeenCalledWith({ type: 'changeSettings', change: { run: { wakeUpReadBudget: RUN_SETTINGS_DEFAULTS.wakeUpReadBudget } } });
  });

  it('/settings opens a collapsed panel and a collapsed Run section, and focuses Run', () => {
    fireEvent.click(runToggle());
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(document.querySelector('.setup-panel-body')).toHaveClass('collapsed');

    send({ type: 'openSettings' });

    expect(document.querySelector('.setup-panel-body')).not.toHaveClass('collapsed');
    expect(screen.getByRole('region', { name: 'Run' })).toHaveFocus();
    expect(runToggle()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(runToggle());
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    send({ type: 'openSettings' });
    expect(runToggle()).toHaveAttribute('aria-expanded', 'true');
  });
});
