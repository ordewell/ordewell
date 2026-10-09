import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationMessage, SessionMessage, SkillLoadNotice } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { stripAnsi, style } from '../ansi';
import type { TuiState } from '../state';
import { registerSkillCommands } from '../slash';
import { messagesOf } from './chat';

const grilling: SkillLoadNotice = { invokedBy: 'user', name: 'grilling', source: 'global', path: '~/.ordewell/skills/grilling/SKILL.md' };

const typing = (text: string, cols = 80): TuiState => ({
  ...initialState({ rows: 30, cols }),
  editor: { ...initialState().editor, text, cursor: text.length },
});

const hear = (state: TuiState, message: SessionMessage): TuiState => reduce(state, { type: 'sessionMessage', message }).state;

/** The chat pane's rows, paint stripped, from the user's line on. */
function rowsFrom(state: TuiState, head: string, count: number): string[] {
  const rows = render(state).map((row) => stripAnsi(row).trimEnd());
  const start = rows.findIndex((row) => row.startsWith(head));
  if (start < 0) throw new Error(`no row starts with "${head}" in:\n${rows.join('\n')}`);
  return rows.slice(start, start + count);
}

function sent(text: string, skills: SkillLoadNotice[], cols = 80): TuiState {
  const { state } = reduce(typing(text, cols), { type: 'key', key: { name: 'enter' } });
  return hear(state, { type: 'planner_turn_started', turnId: 't1', prompt: text, ...(skills.length > 0 ? { skills } : {}) });
}

beforeEach(() => registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]));
afterEach(() => {
  registerSkillCommands([]);
  style.enabled = true;
});

describe('a message that loads a skill', () => {
  it('shows a planner load live and on reload without highlighting a user token', () => {
    const skill: SkillLoadNotice = { ...grilling, invokedBy: 'planner' };
    const live = hear(sent('goal', []), { type: 'planner_skill_loaded', turnId: 't1', skill });
    expect(rowsFrom(live, '❯', 2)).toEqual(['❯ goal', '● grilling skill loaded by planner · ~/.ordewell/skills/grilling/SKILL.md']);
    const history: ConversationMessage[] = [
      { role: 'user', content: 'goal', timestamp: 't1' },
      { role: 'assistant', content: 'grilling skill loaded by planner', timestamp: 't2', kind: 'skill_load', skill: { ...skill, content: 'HIDDEN BODY' } },
    ];
    const { state } = reduce(initialState({ rows: 60, cols: 80, sessionId: 's1' }), { type: 'chatRestored', history, sessionId: 's1' });
    expect(rowsFrom(state, '❯', 2)).toEqual(rowsFrom(live, '❯', 2));
    expect(render(state).map(stripAnsi).join('\n')).not.toContain('HIDDEN BODY');
  });

  it('shows the message once, as typed, with the load notice right under it', () => {
    const state = sent('/grilling the cache design', [grilling]);

    expect(messagesOf(state).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['/grilling the cache design']);
    expect(rowsFrom(state, '❯', 3)).toEqual([
      '❯ /grilling the cache design',
      '● /grilling skill loaded · ~/.ordewell/skills/grilling/SKILL.md',
      '',
    ]);
  });

  it('paints the token that loaded the skill, and not a repeat or a token that loaded nothing', () => {
    style.enabled = true;
    const state = sent('/grilling it, /grilling again and /nope', [grilling]);
    const row = render(state).find((r) => stripAnsi(r).startsWith('❯')) ?? '';

    expect(row).toContain(style.cyan('/grilling'));
    expect(row).toContain(' /grilling again');
    expect(row).not.toContain(style.cyan('/nope'));
  });

  it('cuts the path from the left in a narrow pane', () => {
    style.enabled = false;
    const [, notice] = rowsFrom(sent('/grilling', [grilling], 44), '❯', 2);

    expect(notice.startsWith('● /grilling skill loaded · …')).toBe(true);
    expect(notice.endsWith('/SKILL.md')).toBe(true);
  });

  it('shows a bare unknown /name as an ordinary message with no notice', () => {
    registerSkillCommands([{ name: 'nope', description: 'gone since' }]);
    const state = sent('/nope', []);

    expect(state.conversation.blocks.some((b) => b.type === 'skill_load')).toBe(false);
    expect(messagesOf(state).filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['/nope']);
  });
});

describe('a reloaded session', () => {
  const history: ConversationMessage[] = [
    { role: 'user', content: '/grilling the cache', timestamp: '2026-10-09T10:00:00.000Z' },
    { role: 'user', content: '/grilling skill loaded', timestamp: '2026-10-09T10:00:00.000Z', kind: 'skill_load', skill: { ...grilling, content: 'GRILL' } },
    { role: 'assistant', content: 'Which store?', timestamp: '2026-10-09T10:00:05.000Z' },
  ];

  it('shows the message as typed with its load notice, never the skill body', () => {
    style.enabled = false;
    const { state } = reduce(initialState({ rows: 60, cols: 80, sessionId: 's1' }), { type: 'chatRestored', history, sessionId: 's1' });

    expect(rowsFrom(state, '❯ /', 4)).toEqual([
      '❯ /grilling the cache',
      '● /grilling skill loaded · ~/.ordewell/skills/grilling/SKILL.md',
      '',
      '◆ Which store?',
    ]);
    expect(render(state).map(stripAnsi).join('\n')).not.toContain('GRILL');
  });

  it('shows a session saved with the skill spliced in as it was saved', () => {
    style.enabled = false;
    const legacy: ConversationMessage[] = [{ role: 'user', content: '# Grilling body', timestamp: '2026-10-09T10:00:00.000Z' }];
    const { state } = reduce(initialState({ rows: 60, cols: 80, sessionId: 's1' }), { type: 'chatRestored', history: legacy, sessionId: 's1' });

    expect(rowsFrom(state, '❯ #', 1)).toEqual(['❯ # Grilling body']);
    expect(state.conversation.blocks.some((b) => b.type === 'skill_load')).toBe(false);
  });
});
