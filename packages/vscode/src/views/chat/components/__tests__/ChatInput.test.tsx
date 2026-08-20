import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChatInput, { getLeadingSlashToken } from '../ChatInput';

// jsdom has no layout engine; the suggestion list calls scrollIntoView on nav.
(Element.prototype as never).scrollIntoView = vi.fn();

type ModelOption = NonNullable<React.ComponentProps<typeof ChatInput>['modelOptions']>[number];

const MODELS: ModelOption[] = [
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', provider: 'Deepseek', apiProvider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', provider: 'Anthropic', apiProvider: 'openrouter' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', apiProvider: 'google' },
];

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
      modelOptions={props.modelOptions ?? MODELS}
      configuredProviders={props.configuredProviders ?? ['openrouter', 'google']}
      placeholder={props.placeholder}
      isProcessing={props.isProcessing}
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

describe('ChatInput two-step model picker', () => {
  it('/model set with two providers shows provider entries, not models', () => {
    renderInput({ configuredProviders: ['openrouter', 'google'] });
    type('/model set ');
    expect(screen.getByText('Use OpenRouter models')).toBeTruthy();
    expect(screen.getByText('Use Gemini models')).toBeTruthy();
    expect(screen.queryByText('DeepSeek Chat')).toBeNull();
    expect(screen.queryByText('Gemini 2.5 Pro')).toBeNull();
  });

  it('selecting a provider entry shows that provider\'s models plus a back entry', () => {
    renderInput({ configuredProviders: ['openrouter', 'google'] });
    type('/model set ');
    fireEvent.mouseDown(screen.getByText('Use OpenRouter models'));
    expect(screen.getByText('DeepSeek Chat')).toBeTruthy();
    expect(screen.getByText('Claude Sonnet 4')).toBeTruthy();
    // Gemini model is filtered out — wrong provider.
    expect(screen.queryByText('Gemini 2.5 Pro')).toBeNull();
    expect(screen.getByText('← Back to providers')).toBeTruthy();
  });

  it('back entry returns to provider selection', () => {
    renderInput({ configuredProviders: ['openrouter', 'google'] });
    type('/model set ');
    fireEvent.mouseDown(screen.getByText('Use Gemini models'));
    expect(screen.getByText('Gemini 2.5 Pro')).toBeTruthy();
    fireEvent.mouseDown(screen.getByText('← Back to providers'));
    expect(screen.getByText('Use OpenRouter models')).toBeTruthy();
    expect(screen.getByText('Use Gemini models')).toBeTruthy();
    expect(screen.queryByText('Gemini 2.5 Pro')).toBeNull();
  });

  it('one configured provider skips the provider step and lists models directly', () => {
    renderInput({ configuredProviders: ['openrouter'] });
    type('/model set ');
    expect(screen.queryByText('Use OpenRouter models')).toBeNull();
    expect(screen.getByText('DeepSeek Chat')).toBeTruthy();
    expect(screen.queryByText('← Back to providers')).toBeNull();
  });

  it('no configured providers shows a hint, not models', () => {
    renderInput({ configuredProviders: [] });
    type('/model set ');
    expect(screen.getByText('No API keys configured')).toBeTruthy();
    expect(screen.queryByText('DeepSeek Chat')).toBeNull();
  });

  it('selecting a model sends the slash command with the model id', () => {
    const { onSend } = renderInput({ configuredProviders: ['openrouter'] });
    type('/model set ');
    fireEvent.mouseDown(screen.getByText('Claude Sonnet 4'));
    expect(onSend).toHaveBeenCalledWith('/model set anthropic/claude-sonnet-4');
  });

  it('filters models by search term once a provider is chosen', () => {
    renderInput({ configuredProviders: ['openrouter'] });
    type('/model set sonnet');
    expect(screen.getByText('Claude Sonnet 4')).toBeTruthy();
    expect(screen.queryByText('DeepSeek Chat')).toBeNull();
  });

  it('does not commit a free-typed model id — only selections from the list are sent', () => {
    const { onSend } = renderInput({ configuredProviders: ['openrouter'] });
    // A search term that matches nothing in the list.
    const ta = type('/model set totally-made-up-model');
    fireEvent.keyDown(ta, { key: 'Enter' });
    // Must never send the raw typed id; at most it opens the picker (bare cmd).
    for (const call of onSend.mock.calls) {
      expect(call[0]).not.toContain('totally-made-up-model');
    }
  });

  it('Enter on a filtered match applies that model (selection from the list)', () => {
    const { onSend } = renderInput({ configuredProviders: ['openrouter'] });
    const ta = type('/model set sonnet');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/model set anthropic/claude-sonnet-4');
  });

  it('always displays which API serves each model, disambiguating collisions', () => {
    // The same model offered by both APIs (distinct ids) must be tellable apart.
    const collide: ModelOption[] = [
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', apiProvider: 'openrouter' },
      { id: 'gemini:gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', apiProvider: 'google' },
    ];
    renderInput({ modelOptions: collide, configuredProviders: ['openrouter', 'google'] });
    type('/model set ');
    fireEvent.mouseDown(screen.getByText('Use Gemini models'));
    expect(screen.getByText(/via Gemini/)).toBeTruthy();
    expect(screen.queryByText(/via OpenRouter/)).toBeNull();
  });
});

describe('ChatInput send/stop button', () => {
  it('shows send arrow when not processing', () => {
    const { container } = renderInput({ isProcessing: false });
    const btn = container.querySelector('.send-btn');
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute('title')).toContain('Send');
    expect(btn!.className).not.toContain('processing');
  });

  it('shows stop square when processing', () => {
    const { container } = renderInput({ isProcessing: true });
    const btn = container.querySelector('.send-btn');
    expect(btn).toBeTruthy();
    expect(btn!.className).toContain('processing');
    expect(btn!.getAttribute('title')).toContain('Stop');
  });

  it('calls onStop when clicked while processing', () => {
    const onStop = vi.fn();
    const { container } = renderInput({ isProcessing: true, onStop });
    const btn = container.querySelector('.send-btn')!;
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does not call onSend when clicked while processing', () => {
    const onSend = vi.fn();
    const { container } = renderInput({ isProcessing: true, onSend });
    const btn = container.querySelector('.send-btn')!;
    fireEvent.click(btn);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('calls onSend when clicked while not processing', () => {
    const onSend = vi.fn();
    const { container } = renderInput({ isProcessing: false, onSend });
    type('hello');
    const btn = container.querySelector('.send-btn')!;
    fireEvent.click(btn);
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('is never disabled when processing', () => {
    const { container } = renderInput({ isProcessing: true });
    const btn = container.querySelector('.send-btn')!;
    expect(btn).not.toHaveAttribute('disabled');
  });

  it('calls onStop when clicked while processing and disabled (plan generation)', () => {
    const onStop = vi.fn();
    const { container } = renderInput({ isProcessing: true, disabled: true, onStop });
    const btn = container.querySelector('.send-btn')!;
    expect(btn).not.toHaveAttribute('disabled');
    fireEvent.click(btn);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('is disabled when not processing and no input', () => {
    const { container } = renderInput({ isProcessing: false });
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

describe('getLeadingSlashToken', () => {
  const KNOWN = new Set(['model', 'grilling']);

  it('matches a known command name at the start of the text', () => {
    expect(getLeadingSlashToken('/model set foo', KNOWN)).toBe('/model');
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
    type('/model set foo');
    const mark = container.querySelector('.chat-input-highlight-backdrop mark');
    expect(mark?.textContent).toBe('/model');
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

describe('queue badge', () => {
  it('shows queue badge when queueCount > 0', () => {
    renderInput({ queueCount: 3 });
    expect(document.querySelector('.chat-input-queue-badge')).toBeTruthy();
  });

  it('does not show queue badge when queueCount is 0', () => {
    const { container } = renderInput({ queueCount: 0 });
    expect(container.querySelector('.chat-input-queue-badge')).toBeNull();
  });
});
