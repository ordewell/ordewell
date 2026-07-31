import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatMessage, { Activity } from '../ChatMessage';
import { Message } from '@ordewell/core';

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'user',
    content: 'Hello world',
    timestamp: 1700000000000,
    ...overrides,
  };
}

function mkAct(overrides: Partial<Activity> & { id: string; type: Activity['type']; text: string }): Activity {
  return { ...overrides };
}

describe('ChatMessage', () => {
  it('renders user message right-aligned', () => {
    render(<ChatMessage message={makeMsg({ role: 'user' })} />);
    const el = document.querySelector('.chat-msg-user');
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('Hello world');
  });

  it('renders planner message left-aligned with markdown', () => {
    render(<ChatMessage message={makeMsg({ role: 'planner', content: '**Bold** text `code`' })} />);
    const el = document.querySelector('.chat-msg-planner');
    expect(el).toBeTruthy();
    const content = el!.querySelector('.chat-msg-content');
    expect(content!.innerHTML).toContain('<strong>Bold</strong>');
    expect(content!.innerHTML).toContain('<code>code</code>');
  });

  it('renders system message centered and muted', () => {
    render(<ChatMessage message={makeMsg({ role: 'system', content: 'Task completed' })} />);
    const el = document.querySelector('.chat-msg-system');
    expect(el).toBeTruthy();
    expect(el!.textContent).toContain('Task completed');
  });

  it('shows an inline working indicator on an empty streaming turn — no separate cancel button', () => {
    render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} streaming activities={[]} />);
    const el = document.querySelector('.chat-msg-planner');
    expect(el).toBeTruthy();
    expect(el!.querySelector('.chat-msg-working')).toBeTruthy();
    expect(el!.querySelector('.chat-msg-spinner')).toBeTruthy();
    // The only stop control is the chat input's send/stop button.
    expect(document.querySelector('.chat-msg-interrupt-btn')).toBeNull();
  });

  it('shows queued badge on user messages when isQueued', () => {
    render(<ChatMessage message={makeMsg({ role: 'user', content: 'Build it' })} isQueued />);
    expect(screen.getByText('queued')).toBeTruthy();
    expect(document.querySelector('.chat-msg-queued-badge')).toBeTruthy();
  });

  it('does not show queued badge on planner or system messages', () => {
    render(<ChatMessage message={makeMsg({ role: 'planner' })} isQueued />);
    expect(document.querySelector('.chat-msg-queued-badge')).toBeNull();
  });

  it('renders timestamp on user and planner messages', () => {
    const ts = 1700000000000;
    render(<ChatMessage message={makeMsg({ role: 'user', timestamp: ts })} />);
    expect(document.querySelector('.chat-msg-time')).toBeTruthy();

    const { container } = render(<ChatMessage message={makeMsg({ role: 'planner', timestamp: ts })} />);
    expect(container.querySelector('.chat-msg-time')).toBeTruthy();
  });

  it('does not render timestamp on system messages', () => {
    render(<ChatMessage message={makeMsg({ role: 'system', timestamp: 1700000000000 })} />);
    expect(document.querySelector('.chat-msg-time')).toBeNull();
  });

  describe('interrupted state', () => {
    it('shows interrupted label and dashed border', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: 'Partial output' })} interrupted={true} />);
      const el = document.querySelector('.chat-msg-planner');
      expect(el).toBeTruthy();
      expect(el!.classList.contains('chat-msg-interrupted')).toBe(true);
      expect(document.querySelector('.chat-msg-interrupted-label')).toBeTruthy();
    });
  });

  describe('activity stream', () => {
    const sampleActivities: Activity[] = [
      mkAct({ id: 'a1', type: 'thinking', text: 'Let me analyze the codebase...' }),
      mkAct({ id: 'a2', type: 'tool_call', text: 'read auth.ts', tool: 'read', done: true }),
      mkAct({ id: 'a3', type: 'thinking', text: 'I see the auth module uses JWT.' }),
    ];

    it('renders each activity as a sequential item in .chat-msg-activities', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: 'Researching...' })} activities={sampleActivities} />);
      const container = document.querySelector('.chat-msg-activities');
      expect(container).toBeTruthy();
      expect(container!.children.length).toBe(3);
    });

    it('renders a finished thinking activity collapsed with a chevron toggle', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: 'Done.' })} activities={[mkAct({ id: 'a1', type: 'thinking', text: 'Analyzing...' })]} />);
      expect(document.querySelector('.activity-think-toggle')).toBeTruthy();
      expect(document.querySelector('.activity-think.expanded')).toBeNull();
      expect(document.querySelector('.activity-think-chevron')!.textContent).toBe('▶');
    });

    it('keeps a streaming thinking dropdown collapsed by default, labelled "Thinking…"', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: '' })}
          streaming
          activities={[mkAct({ id: 'a1', type: 'thinking', text: 'Reasoning about the goal…' })]}
        />,
      );
      expect(document.querySelector('.activity-think.expanded')).toBeNull();
      expect(document.querySelector('.activity-think-toggle')!.textContent).toContain('Thinking…');
    });

    it('collapses an opened thinking block by clicking anywhere in its text', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: '' })}
          streaming
          activities={[mkAct({ id: 'a1', type: 'thinking', text: 'Reasoning…' })]}
        />,
      );
      fireEvent.click(document.querySelector('.activity-think-toggle')!);
      expect(document.querySelector('.activity-think.expanded')).toBeTruthy();
      fireEvent.click(document.querySelector('.activity-think-body')!);
      expect(document.querySelector('.activity-think.expanded')).toBeNull();
    });

    it('renders in-flight streamed prose as a thinking dropdown, not as message content', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: 'Let me read the full file using a different approach:' })}
          streaming
          activities={[]}
        />,
      );
      expect(document.querySelector('.chat-msg-content')).toBeNull();
      const toggle = document.querySelector('.activity-think-toggle')!;
      expect(toggle.textContent).toContain('Thinking…');
      fireEvent.click(toggle);
      expect(document.querySelector('.activity-think-pre')!.textContent).toContain('different approach');
    });

    it('trims trailing whitespace from finalized planner text and opened thinking text', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: 'Here is my question.\n\n\n\n' })} />);
      expect(document.querySelector('.chat-msg-content')!.textContent).toBe('Here is my question.');

      const { container } = render(
        <ChatMessage message={makeMsg({ role: 'planner', content: '' })} activities={[mkAct({ id: 'a1', type: 'thinking', text: '\nPondering…\n\n' })]} />,
      );
      fireEvent.click(container.querySelector('.activity-think-toggle')!);
      expect(container.querySelector('.activity-think-pre')!.textContent).toBe('Pondering…');
    });

    it('renders no content element on a finalized planner turn with empty text', () => {
      render(
        <ChatMessage message={makeMsg({ role: 'planner', content: '  \n ' })} activities={[mkAct({ id: 'a1', type: 'thinking', text: 'Done.' })]} />,
      );
      expect(document.querySelector('.chat-msg-content')).toBeNull();
    });

    it('expands a collapsed thinking block on toggle click', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: 'Done.' })} activities={[mkAct({ id: 'a1', type: 'thinking', text: 'Analyzing...' })]} />);
      expect(document.querySelector('.activity-think.expanded')).toBeNull();
      fireEvent.click(document.querySelector('.activity-think-toggle')!);
      expect(document.querySelector('.activity-think.expanded')).toBeTruthy();
      expect(document.querySelector('.activity-think-pre')!.textContent).toBe('Analyzing...');
    });

    it('renders a pending command execution with gear icon and tool name', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} streaming activities={[mkAct({ id: 'a2', type: 'tool_call', text: 'read', tool: 'read' })]} />);
      expect(document.querySelector('.activity-tool-call')).toBeTruthy();
      expect(document.querySelector('.activity-tool-icon')!.textContent).toBe('⚙');
      expect(document.querySelector('.activity-tool-name')!.textContent).toContain('read');
    });

    it('renders a finished command execution with a check and the result summary', () => {
      render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} streaming activities={[mkAct({ id: 'a2', type: 'tool_call', text: 'read auth.ts', tool: 'read', done: true })]} />);
      expect(document.querySelector('.activity-tool-icon')!.textContent).toBe('✓');
      expect(document.querySelector('.activity-tool-name')!.textContent).toBe('read auth.ts');
    });

    it('renders a refused command distinctly from a successful one, with the reason named', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: '' })}
          activities={[mkAct({ id: 'a2', type: 'tool_call', text: 'bash: rm -rf /', tool: 'bash', done: true, outcome: 'refused' })]}
        />,
      );
      expect(document.querySelector('.activity-tool-icon')!.textContent).toBe('⊘');
      expect(document.querySelector('.activity-tool-outcome')!.textContent).toBe('refused');
    });

    it('marks a call the budget never ran as not executed', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: '' })}
          activities={[mkAct({ id: 'a2', type: 'tool_call', text: 'glob **/*.ts', tool: 'glob', done: true, outcome: 'not_executed' })]}
        />,
      );
      expect(document.querySelector('.activity-tool-icon')!.textContent).toBe('–');
      expect(document.querySelector('.activity-tool-outcome')!.textContent).toBe('not executed');
    });

    it('expands any tool call to its result body, not just a subagent digest', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: '' })}
          activities={[mkAct({
            id: 'a2', type: 'tool_call', text: 'read_file auth.ts', tool: 'read_file', done: true,
            outcome: 'success', resultText: 'export const auth = 1;',
          })]}
        />,
      );
      expect(document.querySelector('.activity-tool-call.expanded')).toBeNull();
      fireEvent.click(document.querySelector('.activity-tool-toggle')!);
      expect(document.querySelector('.activity-tool-pre')!.textContent).toBe('export const auth = 1;');

      fireEvent.click(document.querySelector('.activity-tool-body')!);
      expect(document.querySelector('.activity-tool-call.expanded')).toBeNull();
    });

    it('offers no chevron for a call with no result to show', () => {
      render(
        <ChatMessage
          message={makeMsg({ role: 'planner', content: '' })}
          streaming
          activities={[mkAct({ id: 'a2', type: 'tool_call', text: 'read_file auth.ts', tool: 'read_file' })]}
        />,
      );
      expect(document.querySelector('.activity-tool-chevron')).toBeNull();
      expect((document.querySelector('.activity-tool-toggle') as HTMLButtonElement).disabled).toBe(true);
    });

    describe('subagent activity (issue #34)', () => {
      const nestedCall = mkAct({ id: 'c1', type: 'tool_call', text: 'read_file', tool: 'read_file', done: true });
      const subagent: Activity = mkAct({
        id: 'sub-1', type: 'subagent', text: 'spawn: "explore auth"',
        children: [nestedCall],
      });

      it('renders a running subagent collapsed by default with a running badge', () => {
        render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} streaming activities={[subagent]} />);
        expect(document.querySelector('.activity-subagent-toggle')).toBeTruthy();
        expect(document.querySelector('.activity-subagent.expanded')).toBeNull();
        expect(document.querySelector('.activity-subagent-label')!.textContent).toContain('explore auth');
        expect(document.querySelector('.activity-subagent-icon')!.textContent).toBe('⚙');
        expect(document.querySelector('.activity-subagent-badge')).toBeTruthy();
      });

      it('expands to reveal its nested tool call, itself rendered through ActivityBlock', () => {
        render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} activities={[subagent]} />);
        fireEvent.click(document.querySelector('.activity-subagent-toggle')!);
        expect(document.querySelector('.activity-subagent.expanded')).toBeTruthy();
        expect(document.querySelector('.activity-tool-call')).toBeTruthy();
        expect(document.querySelector('.activity-tool-name')!.textContent).toBe('read_file');
      });

      it('nests an independently expandable thinking block inside the subagent for a nested thinking activity', () => {
        const withThinking: Activity = { ...subagent, children: [mkAct({ id: 'c2', type: 'thinking', text: 'Considering the JWT flow…' })] };
        render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} activities={[withThinking]} />);
        fireEvent.click(document.querySelector('.activity-subagent-toggle')!);
        const nestedToggle = document.querySelector('.activity-subagent-body .activity-think-toggle')!;
        expect(nestedToggle).toBeTruthy();
        expect(document.querySelector('.activity-subagent-body .activity-think.expanded')).toBeNull();
        fireEvent.click(nestedToggle);
        expect(document.querySelector('.activity-subagent-body .activity-think.expanded')).toBeTruthy();
        expect(document.querySelector('.activity-subagent-body .activity-think-pre')!.textContent).toContain('JWT flow');
      });

      it('shows a done subagent with a check icon, no running badge, and its digest as a separate expandable block', () => {
        const done: Activity = { ...subagent, done: true, resultText: 'Digest: auth uses JWT with a 1h expiry.' };
        render(<ChatMessage message={makeMsg({ role: 'planner', content: '' })} activities={[done]} />);
        expect(document.querySelector('.activity-subagent-icon')!.textContent).toBe('✓');
        expect(document.querySelector('.activity-subagent-badge')).toBeNull();
        fireEvent.click(document.querySelector('.activity-subagent-toggle')!);
        const thinkBlocks = document.querySelectorAll('.activity-subagent-body > .activity-think');
        expect(thinkBlocks.length).toBe(1);
        fireEvent.click(thinkBlocks[0].querySelector('.activity-think-toggle')!);
        expect(thinkBlocks[0].querySelector('.activity-think-pre')!.textContent).toContain('1h expiry');
      });
    });

    it('renders activities above the message text — the order things actually happened', () => {
      render(
        <ChatMessage message={makeMsg({ role: 'planner', content: 'Summary text.' })} activities={sampleActivities}>
          <div className="my-artifact">Artifact content</div>
        </ChatMessage>
      );
      const bubble = document.querySelector('.chat-msg-bubble')!;
      const children = Array.from(bubble.children);
      const activitiesIdx = children.findIndex((c) => c.classList.contains('chat-msg-activities'));
      const contentIdx = children.findIndex((c) => c.classList.contains('chat-msg-content'));
      const artifactsIdx = children.findIndex((c) => c.classList.contains('chat-msg-artifacts'));
      expect(activitiesIdx).toBeLessThan(contentIdx);
      expect(contentIdx).toBeLessThan(artifactsIdx);
    });
  });
});

describe('ChatMessage — tool call outcome styling', () => {
  const outcomeOf = (act: Partial<Activity>) => {
    render(
      <ChatMessage
        message={makeMsg({ role: 'planner', content: '' })}
        activities={[mkAct({ id: 'a1', type: 'tool_call', text: 'bash npm test', tool: 'bash', ...act })]}
      />,
    );
    return document.querySelector('.activity-tool-call')!.getAttribute('data-outcome');
  };

  // The glyph alone was too quiet to separate a refused call from a successful
  // one; the outcome is published as an attribute so CSS can colour the row.
  it.each([
    ['success', { done: true, outcome: 'success' as const }],
    ['failure', { done: true, outcome: 'failure' as const }],
    ['refused', { done: true, outcome: 'refused' as const }],
    ['not_executed', { done: true, outcome: 'not_executed' as const }],
    ['pending', {}],
    ['success', { done: true }],
  ])('publishes %s', (expected, act) => {
    expect(outcomeOf(act)).toBe(expected);
  });

  it('reserves the chevron column on a call with no output, so rows stay aligned', () => {
    render(
      <ChatMessage
        message={makeMsg({ role: 'planner', content: '' })}
        activities={[mkAct({ id: 'a1', type: 'tool_call', text: 'read_file a.ts', tool: 'read_file', done: true })]}
      />,
    );
    expect(document.querySelector('.activity-tool-chevron')).toBeNull();
    expect(document.querySelector('.activity-tool-chevron-spacer')).not.toBeNull();
  });
});
