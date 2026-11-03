import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import App from '../../test/ChatApp';
import type { RunnerMeta } from '../../shared/protocol';
import { api, post } from './webview';

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** The runner list as the host sends it: every installed runner, with the ones the saved list holds on. */
const list = (...on: string[]): RunnerMeta[] =>
  Object.entries(NAMES).map(([id, displayName]) => ({ id, displayName, enabled: on.includes(id) }));

const pill = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.runner-pill')].find((p) => p.textContent?.includes(name));
  if (!found) throw new Error(`no ${name} pill`);
  return found;
};

/** The state each pill shows: on, off, or disabled (not in the saved list). */
const states = (): Record<string, string> =>
  Object.fromEntries([...document.querySelectorAll<HTMLElement>('.runner-pill')].map((p) => [
    p.textContent!.trim(),
    (['disabled', 'on', 'off'] as const).find((s) => p.classList.contains(s)) ?? '?',
  ]));

/** The names of the pills still showing a click the host has not answered. */
const pending = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.runner-pill.pending')].map((p) => p.textContent!.trim()).sort();

type RunnerRequest = { type: 'setRunnerEnabled'; runnerId: string; enabled: boolean; requestId: string };

/** What the webview asked the host to do about runners since the mock was last cleared. */
const runnerRequests = (): RunnerRequest[] =>
  api.post.mock.calls.map(([msg]) => msg as { type: string }).filter((m): m is RunnerRequest => m.type === 'setRunnerEnabled');

/** The host's answer to one request: the state the shared list now holds for that runner, under the id the click carried. */
const answer = (request: Pick<RunnerRequest, 'requestId' | 'runnerId'>, enabled: boolean): void =>
  post({ type: 'runnerChoiceSaved', requestId: request.requestId, runnerId: request.runnerId, enabled });

/** The runners the next message to the planner would name. */
const runnersSentWith = (text: string): unknown => {
  api.post.mockClear();
  const box = document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
  return (api.post.mock.calls.map(([msg]) => msg as { type: string; runners?: unknown }).find((m) => m.type === 'sendMessage'))?.runners;
};

// The pills are the user's saved choice of runners (ADR-0043), not a selection
// kept in the webview: a click asks the host to save it, and what the host
// answers is what the pills show.
describe('the Runners block pills are the saved runner choice', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('shows every saved-enabled runner on, and the rest disabled', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
  });

  it('asks the host to save Codex off when it is clicked from all three on, under a request id', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'on', OpenCode: 'on' });
    api.post.mockClear();

    fireEvent.click(pill('Codex'));

    expect(runnerRequests()).toEqual([{ type: 'setRunnerEnabled', runnerId: 'codex', enabled: false, requestId: expect.any(String) }]);
    expect(runnerRequests()[0].requestId).not.toBe('');
    expect(states().Codex).toBe('disabled');
    expect(pending()).toEqual(['Codex']);
  });

  it('shows the pill the way the host says after the save, and Codex disabled for the next plan too', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));

    answer(runnerRequests()[0], false);
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
    expect(pending()).toEqual([]);
  });

  it('puts Codex back on when the host answers that the save was rejected', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));
    expect(runnerRequests()).toHaveLength(1);

    // The shared list still holds Codex: the host's answer to this very request.
    answer(runnerRequests()[0], true);

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'on', OpenCode: 'on' });
    expect(pending()).toEqual([]);
  });

  it('does not take an ordinary runner list for a rejected save', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));

    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });

    expect(states().Codex).toBe('disabled');
    expect(pending()).toEqual(['Codex']);
  });

  describe('when a late discovery list lands between the click and the save', () => {
    // Discovery began before the save, so its list still holds Codex; the
    // acknowledgement and the list for the saved choice follow.
    beforeEach(() => {
      post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
      api.post.mockClear();
      fireEvent.click(pill('Codex'));
      post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    });

    it('keeps Codex off and pending until the save is acknowledged', () => {
      expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
      expect(pending()).toEqual(['Codex']);
    });

    it('asks the host for nothing more, and a message sent now still leaves Codex out', () => {
      expect(runnerRequests()).toEqual([{ type: 'setRunnerEnabled', runnerId: 'codex', enabled: false, requestId: expect.any(String) }]);
      expect(runnersSentWith('build it')).toEqual(['claude-code', 'opencode']);
    });

    it('lets only the acknowledgement of that request clear it, and ends on the host\'s final list', () => {
      const [request] = runnerRequests();

      answer({ requestId: 'some-other-request', runnerId: 'codex' }, true);
      expect(states().Codex).toBe('disabled');
      expect(pending()).toEqual(['Codex']);

      answer(request, false);
      expect(pending()).toEqual([]);
      post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

      expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
    });
  });

  it('keeps a click through an ordinary list that changes another runner', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    fireEvent.click(pill('Codex'));

    // Another surface switched OpenCode off in the meantime.
    post({ type: 'setRunners', runners: list('claude-code', 'codex') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'disabled' });
    expect(pending()).toEqual(['Codex']);
  });

  it('settles two runners\' clicks when the acknowledgements come in reverse order', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));
    fireEvent.click(pill('OpenCode'));
    const [codex, opencode] = runnerRequests();
    expect(runnerRequests().map((r) => r.runnerId)).toEqual(['codex', 'opencode']);
    expect(pending()).toEqual(['Codex', 'OpenCode']);

    answer(opencode, false);
    post({ type: 'setRunners', runners: list('claude-code', 'codex') });
    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'disabled' });
    expect(pending()).toEqual(['Codex']);

    answer(codex, false);
    post({ type: 'setRunners', runners: list('claude-code') });
    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'disabled' });
    expect(pending()).toEqual([]);
  });

  it('keeps a newer click on the same runner when an older acknowledgement arrives, or arrives again', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));
    fireEvent.click(pill('Codex'));
    const [off, backOn] = runnerRequests();
    expect(runnerRequests().map((r) => r.enabled)).toEqual([false, true]);
    expect(off.requestId).not.toBe(backOn.requestId);

    answer(off, false);
    expect(states().Codex).toBe('on');
    expect(pending()).toEqual(['Codex']);

    answer(backOn, true);
    expect(states().Codex).toBe('on');
    expect(pending()).toEqual([]);

    answer(off, false);
    expect(states().Codex).toBe('on');
    expect(pending()).toEqual([]);
  });

  it('asks nothing when the last runner on is clicked: the choice is never emptied from here', () => {
    post({ type: 'setRunners', runners: list('claude-code') });
    expect(states()['Claude Code']).toBe('on');
    api.post.mockClear();

    fireEvent.click(pill('Claude Code'));

    expect(runnerRequests()).toEqual([]);
    expect(states()['Claude Code']).toBe('on');
  });
});

describe('the Runners block after the webview is reloaded', () => {
  it('shows the runners the user allowed on, from the host\'s list alone', () => {
    const first = render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });
    first.unmount();
    cleanup();

    render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
    expect(pending()).toEqual([]);
  });

  it('carries no click over, and a late acknowledgement for the old page changes nothing', () => {
    const first = render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));
    const [request] = runnerRequests();
    first.unmount();
    cleanup();

    render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    expect(pending()).toEqual([]);
    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'on', OpenCode: 'on' });

    answer(request, false);

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'on', OpenCode: 'on' });
    expect(pending()).toEqual([]);
  });

  it('is not changed by an acknowledgement that lands after the page is torn down', () => {
    const page = render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.post.mockClear();
    fireEvent.click(pill('Codex'));
    const [request] = runnerRequests();
    page.unmount();
    cleanup();

    expect(() => answer(request, false)).not.toThrow();
  });
});
