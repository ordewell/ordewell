import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { ConversationMessage, SessionMessage, SkillLoadNotice } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, rowKinds } from './hostBridge';

const TURN = 'turn-1';
const grilling: SkillLoadNotice = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md' };
const turnStarted = (prompt: string, skills: SkillLoadNotice[] = []): SessionMessage => ({
  type: 'planner_turn_started', turnId: TURN, prompt, ...(skills.length > 0 ? { skills } : {}),
});

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter' });
}

const userBubbles = () => [...document.querySelectorAll('.chat-msg-user .chat-msg-content')].map((el) => el.textContent);
const notices = () => [...document.querySelectorAll('.chat-msg-skill-load')].map((el) => el.textContent);
const marked = () => [...document.querySelectorAll('.chat-msg-user mark.skill-token')].map((el) => el.textContent);

describe('a message that loads a skill', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('shows one bubble, as typed, with the load notice right under it', () => {
    api.postMessage.mockClear();
    type('/grilling the cache design');
    expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sendMessage', text: '/grilling the cache design' }));
    // The extension echoes a typed prompt into the conversation as it sends it (webviewRouter).
    host.provider.conversation.note('user', '/grilling the cache design');
    host.provider.conversation.flush();
    expect(userBubbles()).toEqual(['/grilling the cache design']);
    host.session(turnStarted('/grilling the cache design', [grilling]));

    expect(userBubbles()).toEqual(['/grilling the cache design']);
    expect(notices()).toEqual(['● /grilling skill loaded · ~/.ordewell/skills/grilling/SKILL.md']);
    expect(rowKinds()).toEqual(['chat-msg', 'chat-msg']);
    expect(document.querySelector('.chat-msg-user + .chat-msg-skill-load')).toBeTruthy();
  });

  it('shows planner attribution live and on reload, without marking a user token', () => {
    const skill: SkillLoadNotice = { ...grilling, invokedBy: 'planner' };
    host.session(turnStarted('/grilling goal'), { type: 'planner_skill_loaded', turnId: TURN, skill });
    expect(notices()).toEqual(['● grilling skill loaded by planner · ~/.ordewell/skills/grilling/SKILL.md']);
    expect(marked()).toEqual([]);
    act(() => host.provider.conversation.reload({ conversationHistory: [
      { role: 'user', content: '/grilling goal', timestamp: 't1' },
      { role: 'assistant', content: 'grilling skill loaded by planner', timestamp: 't2', kind: 'skill_load', skill: { ...skill, content: 'HIDDEN BODY' } },
    ] }));
    expect(notices()).toEqual(['● grilling skill loaded by planner · ~/.ordewell/skills/grilling/SKILL.md']);
    expect(marked()).toEqual([]);
    expect(document.body.textContent).not.toContain('HIDDEN BODY');
  });

  it('marks the token that loaded the skill, and not a repeat or one that loaded nothing', () => {
    host.session(turnStarted('/grilling it, /grilling again and /nope', [grilling]));

    expect(marked()).toEqual(['/grilling']);
    expect(userBubbles()).toEqual(['/grilling it, /grilling again and /nope']);
  });

  it('shows a bare unknown /name as an ordinary message with no notice', () => {
    host.session(turnStarted('/nope'));

    expect(userBubbles()).toEqual(['/nope']);
    expect(notices()).toEqual([]);
    expect(marked()).toEqual([]);
  });
});

describe('a reloaded session', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('shows the message as typed with its load notice, never the skill body', () => {
    const conversationHistory: ConversationMessage[] = [
      { role: 'user', content: '/grilling the cache', timestamp: '2026-10-09T10:00:00.000Z' },
      { role: 'user', content: '/grilling skill loaded', timestamp: '2026-10-09T10:00:00.000Z', kind: 'skill_load', skill: { ...grilling, content: 'GRILL BODY' } },
      { role: 'assistant', content: 'Which store?', timestamp: '2026-10-09T10:00:05.000Z' },
    ];
    act(() => host.provider.conversation.reload({ conversationHistory }));

    expect(userBubbles()).toEqual(['/grilling the cache']);
    expect(marked()).toEqual(['/grilling']);
    expect(notices()).toEqual(['● /grilling skill loaded · ~/.ordewell/skills/grilling/SKILL.md']);
    expect(document.body.textContent).not.toContain('GRILL BODY');
  });

  it('shows a session saved with the skill spliced in as it was saved', () => {
    act(() => host.provider.conversation.reload({ conversationHistory: [{ role: 'user', content: '# Grilling body', timestamp: '2026-10-09T10:00:00.000Z' }] }));

    expect(userBubbles()).toEqual(['# Grilling body']);
    expect(notices()).toEqual([]);
  });
});
