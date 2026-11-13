import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import App from '../../test/ChatApp';
import { api, post } from './webview';
import type { PlannerBackend } from '../../shared/protocol';

/**
 * After a planner pill is clicked, the "Model & thinking effort" controls
 * used to stay live with the previous runner's options until the host's next
 * planner state. The host's messages are driven by hand here, so every
 * interleaving of a delayed, refused or overtaken switch is under the test's
 * control.
 */
const claude: PlannerBackend = { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true };
const codex: PlannerBackend = { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true };
const opencode: PlannerBackend = { id: 'opencode', label: 'OpenCode', kind: 'harness', runner: 'opencode', usable: true };
const BACKENDS = [claude, codex, opencode];

const MODELS_BY_RUNNER = {
  'claude-code': [
    { modelId: 'sonnet', modelLabel: 'Sonnet', runner: 'claude-code', variants: [{ id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] },
    { modelId: 'opus', modelLabel: 'Opus', runner: 'claude-code', variants: [{ id: 'high', label: 'High' }] },
  ],
  codex: [
    { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', runner: 'codex', variants: [{ id: 'minimal', label: 'Minimal' }, { id: 'high', label: 'High' }] },
  ],
  opencode: [
    { modelId: 'oc/model', modelLabel: 'OC Model', runner: 'opencode', variants: [] },
  ],
};

const pill = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.planner-pill')].find((p) => p.textContent === label)!;
const trigger = () => document.querySelector<HTMLElement>('.model-selector .model-picker-trigger')!;
const triggerText = () => document.querySelector('.model-selector .model-picker-label')?.textContent ?? '';
const effortSelect = () => document.querySelector<HTMLSelectElement>('.model-selector .variant-select');
const offeredModels = () => {
  fireEvent.click(trigger());
  const labels = [...document.querySelectorAll('.model-picker-item-label')].map((n) => n.textContent);
  if (document.querySelector('.model-picker-dropdown')) fireEvent.click(trigger());
  return labels;
};
const posted = (type: string) => api.post.mock.calls.map(([m]) => m as { type: string; provider?: string; requestId?: string }).filter((m) => m.type === type);
/** The request the chat sent with its pick of `provider`. */
const requestFor = (provider: string) => posted('setPlanner').filter((m) => m.provider === provider).at(-1)!.requestId!;

/** The host's acknowledged state: Claude Code plans with Sonnet at high effort. */
function acknowledgeClaude() {
  post({ type: 'setConfiguredProviders', providers: [] });
  post({ type: 'setModelsByRunner', modelsByRunner: MODELS_BY_RUNNER });
  post({ type: 'setModelConfig', modelConfig: { orchestrator: 'sonnet' } });
  post({ type: 'setPlannerBackends', backends: BACKENDS, provider: 'claude-code', runner: 'claude-code', effort: 'high' });
}

/** A switch the host saved, as a host sends it: the new planner and its model, then the answer to the pick. */
function answer(provider: 'codex' | 'opencode' | 'claude-code', orchestrator: string) {
  post({ type: 'setPlannerBackends', backends: BACKENDS, provider, runner: provider, effort: 'high' });
  post({ type: 'setModelConfig', modelConfig: { orchestrator } });
  post({ type: 'plannerChoiceSaved', requestId: requestFor(provider) });
}

describe('planner switch: model & effort controls', () => {
  beforeEach(() => {
    render(<App />);
    act(() => acknowledgeClaude());
    api.post.mockClear();
  });

  it('baseline: the acknowledged planner shows its own catalog', () => {
    expect(pill('Claude Code').className).toContain('active');
    expect(triggerText()).toContain('Sonnet');
    expect(effortSelect()?.value).toBe('high');
    expect(offeredModels()).toEqual(['Sonnet', 'Opus']);
  });

  it('does not offer the previous planner\'s models or effort while a switch is pending', () => {
    fireEvent.click(pill('Codex'));
    expect(posted('setPlanner')).toEqual([{ type: 'setPlanner', provider: 'codex', requestId: expect.any(String) }]);
    expect(pill('Codex').className).toContain('active');
    expect(pill('Codex').className).toContain('pending');

    expect({ trigger: triggerText(), effort: effortSelect()?.value ?? null, offered: offeredModels() })
      .toEqual({ trigger: 'Switching to Codex…', effort: null, offered: [] });
    // Said, not only greyed: a screen reader hears why the picker is closed.
    expect(trigger().getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('.model-selector [role="status"]')?.textContent).toBe('Switching to Codex…');
  });

  it('sends no model for the previous runner while the switch is pending', () => {
    fireEvent.click(pill('Codex'));
    fireEvent.click(trigger());
    const opus = [...document.querySelectorAll<HTMLElement>('.model-picker-item')].find((n) => n.textContent?.includes('Opus'));
    if (opus) fireEvent.click(opus);
    const effort = effortSelect();
    if (effort) fireEvent.change(effort, { target: { value: 'low' } });

    expect(posted('setPlannerModel')).toEqual([]);
  });

  it('closes a list opened before the pick, so none of its models can be picked after', () => {
    fireEvent.click(trigger());
    expect(document.querySelector('.model-picker-dropdown')).not.toBeNull();
    // A keyboard press on the pill does not blur the list the way a mouse-down does.
    act(() => { pill('Codex').click(); });
    expect(document.querySelector('.model-picker-dropdown')).toBeNull();
  });

  it('keeps the picker closed through a planner state the host sends before its answer', () => {
    fireEvent.click(pill('Codex'));
    // Detection publishes the planner before the model catalog has answered:
    // the model on hand is still Claude's.
    act(() => post({ type: 'setPlannerBackends', backends: BACKENDS, provider: 'codex', runner: 'codex', effort: 'high' }));
    expect(pill('Codex').className).toContain('pending');
    expect(triggerText()).toBe('Switching to Codex…');
    expect(offeredModels()).toEqual([]);
  });

  it('opens on the new planner\'s own catalog and model once the host answers', () => {
    fireEvent.click(pill('Codex'));
    act(() => answer('codex', 'gpt-5-codex'));
    expect(pill('Codex').className).not.toContain('pending');
    expect(triggerText()).toContain('GPT-5 Codex');
    expect(offeredModels()).toEqual(['GPT-5 Codex']);
    expect(effortSelect()?.value).toBe('high');
  });

  it('a refused switch settles on the planner the host holds, with its catalog back', () => {
    fireEvent.click(pill('Codex'));
    // An error alone names no request: the host's answer, which follows it, settles the pick.
    act(() => post({ type: 'showError', error: 'settings.update failed' }));
    expect(pill('Codex').className).toContain('pending');
    act(() => {
      post({ type: 'setPlannerBackends', backends: BACKENDS, provider: 'claude-code', runner: 'claude-code', effort: 'high' });
      post({ type: 'plannerChoiceSaved', requestId: requestFor('codex') });
    });
    expect(pill('Claude Code').className).toContain('active');
    expect(pill('Codex').className).not.toContain('pending');
    expect(pill('Codex').className).not.toContain('active');
    expect(offeredModels()).toEqual(['Sonnet', 'Opus']);
  });

  it('rapid picks: the first switch\'s answer does not unlight the later pick', () => {
    fireEvent.click(pill('Codex'));
    fireEvent.click(pill('OpenCode'));
    expect(posted('setPlanner').map((m) => m.provider)).toEqual(['codex', 'opencode']);
    // The host answers the Codex switch first; OpenCode's is still running.
    act(() => answer('codex', 'gpt-5-codex'));
    expect(pill('OpenCode').className).toContain('active');
    expect(pill('OpenCode').className).toContain('pending');
    expect(offeredModels()).toEqual([]);

    act(() => answer('opencode', 'oc/model'));
    expect(pill('OpenCode').className).not.toContain('pending');
    expect(offeredModels()).toEqual(['OC Model']);
  });

  it('a late answer to an earlier pick does not settle the later one', () => {
    fireEvent.click(pill('Codex'));
    fireEvent.click(pill('OpenCode'));
    act(() => post({ type: 'plannerChoiceSaved', requestId: requestFor('codex') }));
    expect(pill('OpenCode').className).toContain('pending');
    expect(triggerText()).toBe('Switching to OpenCode…');
  });

  it('picking the current planner again while another pick is pending asks the host for it', () => {
    fireEvent.click(pill('Codex'));
    fireEvent.click(pill('Claude Code'));
    expect(posted('setPlanner').map((m) => m.provider)).toEqual(['codex', 'claude-code']);
    expect(pill('Claude Code').className).toContain('pending');
    act(() => answer('claude-code', 'sonnet'));
    expect(offeredModels()).toEqual(['Sonnet', 'Opus']);
  });
});
