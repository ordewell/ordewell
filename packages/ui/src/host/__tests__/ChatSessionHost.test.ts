import { describe, it, expect, vi } from 'vitest';
import type { DaemonErrorCode } from '@ordewell/core';
import { ChatSessionHost, type ChatTurn, type SessionPort, type TurnOutcome } from '../ChatSessionHost';
import { ConversationViewHost } from '../ConversationViewHost';
import type { HostToWebview } from '../../protocol';

/**
 * A session the test drives: `busy` is the turn the surface saw open, and
 * each turn it is asked for is answered with what `answer` returns.
 */
function harness(answer: (text: string, turn: ChatTurn) => TurnOutcome | Promise<TurnOutcome> = () => ({ ok: true })) {
  const posts: HostToWebview[] = [];
  const conversation = new ConversationViewHost((msg) => posts.push(msg));
  const notes = vi.spyOn(conversation, 'note');
  const turns: { text: string; turn: ChatTurn }[] = [];
  const state = { busy: false, answering: 0 };
  const port: SessionPort = {
    generating: () => state.busy || state.answering > 0,
    answering: () => state.answering > 0,
    converse: async (text, turn) => {
      turns.push({ text, turn });
      state.answering += 1;
      try {
        return await answer(text, turn);
      } finally {
        state.answering -= 1;
      }
    },
  };
  const chat = new ChatSessionHost(conversation, port);
  return {
    chat, conversation, state, turns,
    sent: () => turns.map((t) => [t.text, t.turn.now]),
    held: () => posts.filter((m): m is Extract<HostToWebview, { type: 'heldPrompts' }> => m.type === 'heldPrompts').at(-1)?.prompts ?? [],
    unsent: () => posts.flatMap((m) => (m.type === 'promptUnsent' ? [m.text] : [])),
    userNotes: () => notes.mock.calls.filter(([role]) => role === 'user').map(([, text]) => text),
  };
}

describe('ChatSessionHost', () => {
  it('holds a prompt typed while a turn holds the session, and sends one typed after it as the user\'s', async () => {
    const h = harness();
    h.state.busy = true;

    await h.chat.send('and add tests', true);
    expect(h.held()).toEqual(['and add tests']);
    expect(h.turns).toEqual([]);

    h.state.busy = false;
    await h.chat.send('ship it', true, ['claude-code']);
    // What was held goes after that turn, never ahead of it.
    expect(h.turns).toEqual([
      { text: 'ship it', turn: { now: false, runners: ['claude-code'] } },
      { text: 'and add tests', turn: { now: false } },
    ]);
    expect(h.userNotes()).toEqual(['ship it', 'and add tests']);
  });

  it('answers a button\'s message at once, neither held nor shown as the user\'s', async () => {
    const h = harness();
    h.state.busy = true;

    await h.chat.send('Approve the plan', false);

    expect(h.sent()).toEqual([['Approve the plan', false]]);
    expect(h.userNotes()).toEqual([]);
  });

  it('holds what the chat held only while a turn still holds the session', () => {
    const h = harness();
    h.state.busy = true;
    expect(h.chat.hold('one')).toBe(true);
    h.state.busy = false;
    expect(h.chat.hold('two')).toBe(false);

    expect(h.held()).toEqual(['one']);
  });

  it('takes back the newest held prompt, into the composer when asked', () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('one');
    h.chat.hold('two');

    h.chat.unsend(true);

    expect(h.held()).toEqual(['one']);
    expect(h.unsent()).toEqual(['two']);
  });

  it('sends what was held during its turn, glued, once that turn has returned', async () => {
    const h = harness((text) => {
      if (text === 'first') { h.chat.hold('one'); h.chat.hold('two'); }
      return { ok: true };
    });

    await h.chat.send('first', true);

    expect(h.sent()).toEqual([['first', false], ['one\ntwo', false]]);
    expect(h.held()).toEqual([]);
    expect(h.userNotes()).toEqual(['first', 'one\ntwo']);
  });

  it('releases after its own turn though the surface has not yet seen the turn close', async () => {
    const h = harness((text) => {
      // Over a daemon the answer can come in before the frame that ends the turn.
      if (text === 'first') { h.state.busy = true; h.chat.hold('one'); }
      return { ok: true };
    });

    await h.chat.send('first', true);

    expect(h.sent()).toEqual([['first', false], ['one', false]]);
  });

  it('releases on demand only once no turn holds the session', async () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('typed during the retry');

    await h.chat.release();
    expect(h.turns).toEqual([]);

    h.state.busy = false;
    await h.chat.release();
    expect(h.sent()).toEqual([['typed during the retry', false]]);
  });

  it('sends now everything held with the draft last, stopping the turn in flight', async () => {
    const h = harness();
    h.state.busy = true;
    h.chat.hold('one');
    h.chat.hold('two');

    await h.chat.sendNow('three');

    expect(h.sent()).toEqual([['one\ntwo\nthree', true]]);
    expect(h.held()).toEqual([]);
    expect(h.unsent()).toEqual([]);
    expect(h.userNotes()).toEqual(['one\ntwo\nthree']);
  });

  it('sends now with no turn in flight as a plain send, and nothing at all when nothing is held or typed', async () => {
    const h = harness();

    await h.chat.sendNow('');
    await h.chat.sendNow('a normal reply');

    expect(h.sent()).toEqual([['a normal reply', false]]);
  });

  it.each<[string, DaemonErrorCode | undefined, string[]]>([
    ['refused', 'planner_not_ready', ['one\nthree']],
    ['busy', 'conversation_busy', ['one\nthree']],
    ['failed with no code', undefined, ['one\nthree']],
    ['stopped', 'planner_turn_stopped', []],
    ['discarded with the session left', 'planner_turn_discarded', []],
  ])('gives back what a send now took only when its turn was not stopped or left (%s)', async (_case, code, unsent) => {
    const h = harness(() => ({ ok: false, ...(code ? { code } : {}) }));
    h.state.busy = true;
    h.chat.hold('one');

    await h.chat.sendNow('three');

    expect(h.unsent()).toEqual(unsent);
    expect(h.held()).toEqual([]);
  });

  it('sends what was typed during a send now once its turn returns, after giving back what it took', async () => {
    const order: string[] = [];
    const h = harness((text, turn) => {
      if (turn.now) { h.chat.hold('typed meanwhile'); order.push('forced'); return { ok: false, code: 'planner_not_ready' }; }
      order.push(`sent ${text} with ${h.unsent().join('|')} given back`);
      return { ok: true };
    });
    h.state.busy = true;

    const forced = h.chat.sendNow('use Postgres');
    h.state.busy = false;
    await forced;

    expect(order).toEqual(['forced', 'sent typed meanwhile with use Postgres given back']);
  });
});
