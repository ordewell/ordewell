import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import App from '../../test/ChatApp';
import { api, post } from './webview';

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(textarea(), { key });
const posted = () => api.post.mock.calls.map(([msg]) => msg as { type: string });

describe('queued prompts', () => {
  beforeEach(() => {
    render(<App />);
    api.post.mockClear();
  });

  it('keeps the conversation at its end when a queued prompt takes height from it', () => {
    post({ type: 'plannerTurn', active: true });
    const list = document.querySelector('.message-list') as HTMLElement;
    let top = 0;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    post({ type: 'heldPrompts', prompts: ['also cover caching'] });

    expect(top).toBe(600);
  });

  it('holds a prompt typed while the planner answers, and draws it as queued rather than sent', () => {
    post({ type: 'plannerTurn', active: true });

    expect(textarea().disabled).toBe(false);
    type('also cover caching');
    press('Enter');

    expect(api.post).toHaveBeenCalledWith({ type: 'holdPrompt', text: 'also cover caching' });
    expect(posted().some((m) => m.type === 'sendMessage')).toBe(false);
    expect(textarea().value).toBe('');

    post({ type: 'heldPrompts', prompts: ['also cover caching'] });

    const items = [...document.querySelectorAll('.pending-messages .pending-message')];
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.pending-message-text')?.textContent).toBe('also cover caching');
    expect(items[0].querySelector('.pending-message-state')?.textContent).toBe('queued');
    expect(document.querySelector('.chat-msg-user')).toBeNull();
    // A stack above the composer, not part of the conversation.
    expect(document.querySelector('.message-list .pending-messages')).toBeNull();
    expect(document.querySelector('.pending-messages')?.nextElementSibling?.classList.contains('chat-input')).toBe(true);
  });

  it('takes the newest back into an empty composer with its ×, and planning keeps going', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });

    const unsend = document.querySelectorAll('.pending-message-remove');
    expect(unsend).toHaveLength(1);
    expect(unsend[0].getAttribute('aria-label')).toBe('Remove pending message: two');
    expect(unsend[0].getAttribute('title')).toBe('Take back (Esc)');
    fireEvent.click(unsend[0]);

    expect(api.post).toHaveBeenCalledWith({ type: 'unsendPrompt', toComposer: true });
    // The host answers with what it really took back.
    post({ type: 'promptUnsent', text: 'two' });
    post({ type: 'heldPrompts', prompts: ['one'] });

    expect(textarea().value).toBe('two');
    expect(document.querySelectorAll('.pending-message')).toHaveLength(1);
    expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
    expect(document.querySelector('.chat-msg-working')).not.toBeNull();
  });

  it('discards the newest with its × over a draft, as Esc does', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });
    type('half a thought');

    fireEvent.click(document.querySelector('.pending-message-remove')!);

    expect(api.post).toHaveBeenCalledWith({ type: 'unsendPrompt', toComposer: false });
  });

  it('takes the newest back on Esc while something is queued, instead of arming a stop', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });

    press('Escape');

    expect(api.post).toHaveBeenCalledWith({ type: 'unsendPrompt', toComposer: true });
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
  });

  it('discards the newest on Esc over a draft, keeping the draft', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one'] });
    type('draft');

    press('Escape');

    expect(api.post).toHaveBeenCalledWith({ type: 'unsendPrompt', toComposer: false });
    expect(textarea().value).toBe('draft');
    expect(document.querySelector('.stop-hint')).toBeNull();
  });

  describe('double Esc', () => {
    afterEach(() => vi.useRealTimers());

    it('warns on the first Esc and stops the turn on the second, keeping the draft', () => {
      post({ type: 'plannerTurn', active: true });
      type('draft');

      press('Escape');

      expect(document.querySelector('.stop-hint')?.textContent).toBe('Press Esc again to stop');
      expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
      expect(textarea().value).toBe('draft');

      press('Escape');

      expect(api.post).toHaveBeenCalledWith({ type: 'stopResearch' });
      expect(document.querySelector('.stop-hint')).toBeNull();
      expect(textarea().value).toBe('draft');
    });

    it('lets the warning lapse, so a later Esc only warns again', () => {
      vi.useFakeTimers();
      post({ type: 'plannerTurn', active: true });

      press('Escape');
      act(() => { vi.advanceTimersByTime(2_500); });

      expect(document.querySelector('.stop-hint')).toBeNull();
      press('Escape');
      expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
      expect(document.querySelector('.stop-hint')).not.toBeNull();
    });
  });

  it('clears the input on Esc outside a turn, with nothing to stop or unsend', () => {
    type('never mind');

    press('Escape');

    expect(textarea().value).toBe('');
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('names the keys that stop a turn on the stop button', () => {
    post({ type: 'plannerTurn', active: true });

    expect(document.querySelector('.send-btn')?.getAttribute('title')).toBe('Stop (Esc Esc)');
  });

  it('offers one Send now for the whole held group, which leaves the draft where it is', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });
    type('half a thought');

    const buttons = [...document.querySelectorAll('.pending-messages-now')];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Send all now Ctrl+Enter');
    expect(buttons[0].getAttribute('title')).toContain('(Ctrl+Enter)');
    fireEvent.click(buttons[0]);

    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessageNow', text: '' });
    expect(textarea().value).toBe('half a thought');
  });

  it('sends the held group now on Ctrl+Enter while focus is on a held row', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });

    fireEvent.keyDown(document.querySelectorAll('.pending-message')[0], { key: 'Enter', ctrlKey: true });

    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessageNow', text: '' });
  });

  it('names the chord under an empty composer while prompts are held', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one'] });

    expect(document.querySelector('.send-key-hint')?.textContent).toBe('Ctrl+Enter send all now');
    expect(document.querySelector('.send-btn')?.getAttribute('title')).toBe('Stop (Esc Esc)');
  });

  it('has one button while a turn runs: the hint and its tooltip name the key that sends now', () => {
    post({ type: 'plannerTurn', active: true });
    expect(document.querySelector('.send-key-hint')).toBeNull();

    type('stop, use Postgres');

    expect(document.querySelectorAll('.chat-input-row button')).toHaveLength(1);
    expect(document.querySelector('.send-key-hint')?.textContent).toBe('Enter queue · Ctrl+Enter send all now');
    expect(document.querySelector('.send-btn')?.getAttribute('title')).toBe('Queue (Enter) · Send all now (Ctrl+Enter)');
  });

  it('sends now on Ctrl+Enter', () => {
    post({ type: 'plannerTurn', active: true });
    type('stop, use Postgres');

    fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });

    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessageNow', text: 'stop, use Postgres' });
  });

  // The reported bug: with nothing typed the key fell through to Enter's
  // submit, which ignores an empty composer, so what was held never went.
  it.each([
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
  ])('sends what is held now on %s with an empty composer', (_name, chord) => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });

    fireEvent.keyDown(textarea(), { key: 'Enter', ...chord });

    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessageNow', text: '' });
  });

  it('sends now on Cmd+Enter with text typed', () => {
    post({ type: 'plannerTurn', active: true });
    type('stop, use Postgres');

    fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });

    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessageNow', text: 'stop, use Postgres' });
  });

  it('force sends a skill invocation but runs a built-in slash command as a command', () => {
    post({ type: 'plannerTurn', active: true });

    type('/grilling the cache');
    expect(document.querySelector('.send-key-hint')).not.toBeNull();
    fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });
    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessageNow', text: '/grilling the cache' });

    api.post.mockClear();
    type('/refresh');
    expect(document.querySelector('.send-key-hint')).toBeNull();
    fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });
    expect(api.post).toHaveBeenCalledWith({ type: 'sendMessage', text: '/refresh', runners: expect.any(Array), typed: true });
  });

  it('has no key hint outside a turn, where Enter just sends', () => {
    type('a normal message');
    expect(document.querySelector('.send-key-hint')).toBeNull();
    expect(document.querySelector('.send-btn')?.getAttribute('title')).toBe('Send (Enter)');
  });

  it('sends nothing on Enter with an empty input mid-turn', () => {
    post({ type: 'plannerTurn', active: true });

    press('Enter');

    expect(posted()).toEqual([]);
  });
});
