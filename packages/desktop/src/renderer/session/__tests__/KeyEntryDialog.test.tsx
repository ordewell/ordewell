import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KeyEntryDialog, unsavedKeyWarning } from '../KeyEntryDialog';

function mount(request: Parameters<typeof KeyEntryDialog>[0]['request'] = {}): ReturnType<typeof vi.fn> {
  const answer = vi.fn();
  render(<KeyEntryDialog request={request} answer={answer} />);
  return answer;
}

describe('the key entry', () => {
  it('names the vendor it is for, in core\'s words, and hides the key as it is typed', () => {
    mount({ provider: 'google', runnerLabel: 'Gemini CLI' });
    expect(screen.getByRole('dialog', { name: 'API key for Google Gemini' })).toBeInTheDocument();
    expect(screen.getByText(/Ordewell hands this key to Gemini CLI/)).toHaveTextContent('GEMINI_API_KEY');
    const field = screen.getByLabelText('API key');
    expect(field).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('combobox', { name: 'Provider' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('resolves the provider and the key on Save', () => {
    const answer = mount({ provider: 'openrouter' });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(answer).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-or-secret' });
  });

  it('asks which vendor when no runner named one, then shows that vendor\'s name', () => {
    const answer = mount();
    const picker = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.change(picker, { target: { value: 'openrouter' } });
    expect(screen.getByRole('dialog', { name: 'API key for OpenRouter' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-or' } });
    fireEvent.keyDown(screen.getByLabelText('API key'), { key: 'Enter' });
    expect(answer).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-or' });
  });

  it('answers null on Cancel or Escape, writing nothing', () => {
    const answer = mount({ provider: 'google' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(answer).toHaveBeenCalledWith(null);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(answer).toHaveBeenLastCalledWith(null);
  });
});

describe('a key the daemon took but could not save', () => {
  it('is named, with what to do after a restart, only when the daemon says it was not saved', () => {
    expect(unsavedKeyWarning({ unsavedEnvKeys: ['OPENROUTER_API_KEY'] }, 'openrouter'))
      .toBe('The OpenRouter key is in use, but it could not be saved to ~/.ordewell/.env: once Ordewell restarts, set it again.');
    expect(unsavedKeyWarning({ unsavedEnvKeys: ['GEMINI_API_KEY'] }, 'openrouter')).toBeUndefined();
    expect(unsavedKeyWarning({}, 'openrouter')).toBeUndefined();
    expect(unsavedKeyWarning(null, 'openrouter')).toBeUndefined();
    expect(unsavedKeyWarning({ unsavedEnvKeys: 'OPENROUTER_API_KEY' }, 'openrouter')).toBeUndefined();
  });
});
