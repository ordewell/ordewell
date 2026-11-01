import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatInput, { getLeadingSlashToken } from '../ChatInput';

// jsdom has no layout engine; the suggestion list calls scrollIntoView on nav.
(Element.prototype as never).scrollIntoView = vi.fn();

function renderInput(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onSend = props.onSend ?? vi.fn();
  const onStop = props.onStop ?? vi.fn();
  const rest = { ...props };
  delete rest.onSend;
  delete rest.onStop;
  const utils = render(
    <ChatInput
      onSend={onSend}
      onStop={onStop}
      disabled={props.disabled ?? false}
      placeholder={props.placeholder}
      {...rest}
    />,
  );
  return { ...utils, onSend, onStop };
}

function type(value: string) {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value } });
  return textarea;
}

/** Like `type`, but places the caret at `cursor` instead of the end of `value`. */
function typeAt(value: string, cursor: number) {
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value, selectionStart: cursor, selectionEnd: cursor } });
  return textarea;
}

describe('ChatInput send/stop button', () => {
  it('shows send arrow when not processing', () => {
    const { container } = renderInput({ isTurnRunning: false });
    const btn = container.querySelector('.send-btn');
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute('title')).toContain('Send');
    expect(btn!.className).not.toContain('processing');
  });

  it('shows stop square when processing', () => {
    const { container } = renderInput({ isTurnRunning: true });
    const btn = container.querySelector('.send-btn');
    expect(btn).toBeTruthy();
    expect(btn!.className).toContain('processing');
    expect(btn!.getAttribute('title')).toContain('Stop');
  });

  it('calls onStop when clicked while processing', () => {
    const onStop = vi.fn();
    const { container } = renderInput({ isTurnRunning: true, onStop });
    const btn = container.querySelector('.send-btn')!;
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does not call onSend when clicked while processing', () => {
    const onSend = vi.fn();
    const { container } = renderInput({ isTurnRunning: true, onSend });
    const btn = container.querySelector('.send-btn')!;
    fireEvent.click(btn);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('calls onSend when clicked while not processing', () => {
    const onSend = vi.fn();
    const { container } = renderInput({ isTurnRunning: false, onSend });
    type('hello');
    const btn = container.querySelector('.send-btn')!;
    fireEvent.click(btn);
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('is never disabled when processing', () => {
    const { container } = renderInput({ isTurnRunning: true });
    const btn = container.querySelector('.send-btn')!;
    expect(btn).not.toHaveAttribute('disabled');
  });

  it('calls onStop when clicked while processing and disabled (plan generation)', () => {
    const onStop = vi.fn();
    const { container } = renderInput({ isTurnRunning: true, disabled: true, onStop });
    const btn = container.querySelector('.send-btn')!;
    expect(btn).not.toHaveAttribute('disabled');
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('is disabled when not processing and no input', () => {
    const { container } = renderInput({ isTurnRunning: false });
    const btn = container.querySelector('.send-btn')!;
    expect(btn).toHaveAttribute('disabled');
  });
});

describe('slash command suggestions', () => {
  it('includes /help in command suggestions when typing /', () => {
    renderInput();
    type('/');
    expect(screen.getByText('/help')).toBeTruthy();
  });

  it('offers the conversation-editing commands', () => {
    renderInput();
    type('/');
    for (const name of ['/fork', '/rewind', '/compact']) expect(screen.getByText(name)).toBeTruthy();
  });
});

describe('ChatInput prefill', () => {
  it('prefills the textarea when prefill prop is provided', () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        onSend={onSend}
        onStop={vi.fn()}
        disabled={false}
        prefill="proceed"
      />
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('proceed');
  });

  it('calls onSend when user submits prefill text', () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        onSend={onSend}
        onStop={vi.fn()}
        disabled={false}
        prefill="retry task-3"
      />
    );

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('retry task-3');
  });
});

describe('discovered skill suggestions', () => {
  const SKILLS = [
    { name: 'grilling', description: 'Grill the plan' },
    { name: 'to-spec', description: 'Tighten a spec' },
  ];

  it('typing /gri filters the suggestion list down to /grilling', () => {
    renderInput({ skills: SKILLS });
    type('/gri');
    expect(screen.getByText('/grilling')).toBeTruthy();
    expect(screen.queryByText('/to-spec')).toBeNull();
  });

  it('selecting a skill suggestion sends it as the raw /skill-name message', () => {
    const { onSend } = renderInput({ skills: SKILLS });
    type('/grill');
    fireEvent.mouseDown(screen.getByText('/grilling'));
    expect(onSend).toHaveBeenCalledWith('/grilling');
  });
});

describe('mid-prompt skill suggestions', () => {
  const SKILLS = [{ name: 'grilling', description: 'Grill the plan' }];

  it('suggests a discovered skill for a token typed mid-prompt', () => {
    renderInput({ skills: SKILLS });
    const text = 'explain this bug /gri';
    typeAt(text, text.length);
    expect(screen.getByText('/grilling')).toBeTruthy();
  });

  it('does not suggest a built-in command for a token typed mid-prompt', () => {
    renderInput({});
    const text = 'explain this bug /he';
    typeAt(text, text.length);
    expect(screen.queryByText('/help')).toBeNull();
  });

  it('splices the selected skill into place, keeps the rest of the message, and does not send', () => {
    const { onSend } = renderInput({ skills: SKILLS });
    const text = 'explain this bug /gri then summarize';
    const cursor = text.indexOf('/gri') + '/gri'.length;
    const ta = typeAt(text, cursor) as HTMLTextAreaElement;
    fireEvent.mouseDown(screen.getByText('/grilling'));
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('explain this bug /grilling  then summarize');
  });

  it('shows no suggestion dropdown once the caret has moved past the token', () => {
    const { container } = renderInput({ skills: SKILLS });
    const text = 'explain /grilling to me';
    typeAt(text, text.length);
    expect(container.querySelector('.slash-suggestions')).toBeNull();
  });
});

describe('mid-prompt skill highlight', () => {
  const SKILLS = [{ name: 'grilling', description: 'Grill' }];

  it('highlights a skill token typed in the middle of a longer prompt', () => {
    const { container } = renderInput({ skills: SKILLS });
    const text = 'explain this bug /grilling please';
    typeAt(text, text.length);
    const marks = Array.from(container.querySelectorAll('.chat-input-highlight-backdrop mark')).map((m) => m.textContent);
    expect(marks).toContain('/grilling');
  });

  it('does not highlight a built-in command typed mid-prompt', () => {
    const { container } = renderInput({});
    const text = 'explain this bug /help please';
    typeAt(text, text.length);
    const marks = Array.from(container.querySelectorAll('.chat-input-highlight-backdrop mark')).map((m) => m.textContent);
    expect(marks).not.toContain('/help');
  });

  it('highlights a live-typed prefix of a discovered skill', () => {
    const { container } = renderInput({ skills: SKILLS });
    const text = 'please /gri';
    typeAt(text, text.length);
    const mark = container.querySelector('.chat-input-highlight-backdrop mark');
    expect(mark?.textContent).toBe('/gri');
  });

  it('only highlights the first occurrence of a repeated skill token', () => {
    const { container } = renderInput({ skills: SKILLS });
    const text = '/grilling this and /grilling that';
    typeAt(text, text.length);
    const marks = Array.from(container.querySelectorAll('.chat-input-highlight-backdrop mark')).map((m) => m.textContent);
    expect(marks).toEqual(['/grilling']);
  });
});

describe('getLeadingSlashToken', () => {
  const KNOWN = new Set(['refresh', 'grilling']);

  it('matches a known command name at the start of the text', () => {
    expect(getLeadingSlashToken('/refresh now', KNOWN)).toBe('/refresh');
  });

  it('matches a known skill name with nothing else typed', () => {
    expect(getLeadingSlashToken('/grilling', KNOWN)).toBe('/grilling');
  });

  it('returns null for an unrecognized leading token', () => {
    expect(getLeadingSlashToken('/nope', KNOWN)).toBeNull();
  });

  it('returns null for plain text with no leading slash', () => {
    expect(getLeadingSlashToken('hello world', KNOWN)).toBeNull();
  });
});

describe('slash token highlight', () => {
  it('renders a mark around a recognized command token', () => {
    const { container } = renderInput({});
    type('/refresh now');
    const mark = container.querySelector('.chat-input-highlight-backdrop mark');
    expect(mark?.textContent).toBe('/refresh');
  });

  it('renders a mark around a recognized skill token', () => {
    const { container } = renderInput({ skills: [{ name: 'grilling', description: 'Grill' }] });
    type('/grilling');
    const mark = container.querySelector('.chat-input-highlight-backdrop mark');
    expect(mark?.textContent).toBe('/grilling');
  });

  it('renders no mark for unrecognized input', () => {
    const { container } = renderInput({});
    type('/nope');
    expect(container.querySelector('.chat-input-highlight-backdrop mark')).toBeNull();
  });
});

describe('the empty composer tip (#137)', () => {
  const ALLOWLIST_TIP = 'Tip: Use /allowlist to limit which models the planner assigns per runner.';
  const placeholder = () => (screen.getByRole('textbox') as HTMLTextAreaElement).placeholder;

  it('shows the /allowlist tip in an empty composer that has no state of its own to say', () => {
    renderInput();
    expect(placeholder()).toBe(ALLOWLIST_TIP);
  });

  it('gives way to a placeholder that says what is happening, and to a disabled reason', () => {
    const { unmount } = renderInput({ placeholder: 'Queue a message for when the planner is done...' });
    expect(placeholder()).toBe('Queue a message for when the planner is done...');
    unmount();
    renderInput({ disabled: true, disabledReason: 'Sign the planner in first' });
    expect(placeholder()).toBe('Sign the planner in first');
  });

  it('names the input for assistive technology without relying on the placeholder', () => {
    renderInput();
    expect(screen.getByRole('textbox', { name: 'Message the planner' })).toBeTruthy();
  });

  it('is never part of the text: typed or pasted text is exactly what is there, and an empty Enter sends nothing', () => {
    const { onSend } = renderInput();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect((type('add a login route') as HTMLTextAreaElement).value).toBe('add a login route');
    // A paste reaches the textarea as one change carrying the pasted text.
    expect((type('pasted\nfrom elsewhere') as HTMLTextAreaElement).value).toBe('pasted\nfrom elsewhere');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('pasted\nfrom elsewhere');
  });

  it('holds still while the composer stays empty, and moves on once the text has been cleared', () => {
    const { rerender, onSend, onStop } = renderInput();
    rerender(<ChatInput onSend={onSend} onStop={onStop} disabled={false} />);
    expect(placeholder()).toBe(ALLOWLIST_TIP);
    type('x');
    type('');
    expect(placeholder()).toBe("Tip: Use /planner to pick the planner's harness, model and effort.");
  });

  it('only names commands this chat answers: never /runners, over a whole cycle', () => {
    renderInput();
    const seen = new Set<string>([placeholder()]);
    for (let i = 0; i < 6; i++) {
      type('x');
      type('');
      seen.add(placeholder());
    }
    expect(seen.size).toBe(4);
    expect([...seen].every((tip) => tip.startsWith('Tip: '))).toBe(true);
    expect([...seen].some((tip) => tip.includes('/runners'))).toBe(false);
  });
});
