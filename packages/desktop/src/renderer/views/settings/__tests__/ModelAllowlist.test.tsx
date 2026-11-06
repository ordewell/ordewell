import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredModel } from '@ordewell/core';
import { ALLOWLIST_DEBOUNCE_MS, ModelAllowlist } from '../ModelAllowlist';

const MODELS: DiscoveredModel[] = [
  { modelId: 'claude-opus-4-1', modelLabel: 'Opus 4.1', variants: [] },
  { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet 4.5', variants: [] },
  { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku 4.5', variants: [] },
  { modelId: 'anthropic.very-long-model-identifier-that-would-overflow-a-narrow-column-v1:0', modelLabel: 'Bedrock Long', variants: [] },
];

function setup(props: { ids?: string[]; models?: DiscoveredModel[]; disabled?: boolean; error?: string; onCommit?: (ids: string[] | null) => Promise<void> | void } = {}) {
  const onCommit = props.onCommit ?? vi.fn(async () => undefined);
  const view = (ids: string[] | undefined) => (
    <ModelAllowlist runnerName="Claude Code" models={props.models ?? MODELS} ids={ids} disabled={props.disabled ?? false} error={props.error} onCommit={onCommit} />
  );
  const utils = render(view(props.ids));
  return { onCommit: onCommit as ReturnType<typeof vi.fn>, rerender: (ids: string[] | undefined) => utils.rerender(view(ids)) };
}

const openPicker = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Edit Claude Code models' })); };
const option = (name: RegExp | string): HTMLElement => screen.getByRole('option', { name });
const selectedNames = (): string[] => screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.querySelector('.allowlist-label')?.textContent ?? '');

describe('the collapsed summary', () => {
  it('says "All models" for an empty allowlist', () => {
    setup();
    expect(screen.getByText('All models')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('names the first two allowed models and counts the rest', () => {
    setup({ ids: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'] });
    expect(screen.getByText('3 of 4 models: Opus 4.1, Sonnet 4.5, +1')).toBeInTheDocument();
  });

  it('names a single allowed model without a remainder', () => {
    setup({ ids: ['claude-haiku-4-5'] });
    expect(screen.getByText('1 of 4 models: Haiku 4.5')).toBeInTheDocument();
  });
});

describe('the picker', () => {
  it('opens in place with the search field focused, listing every model with its id', () => {
    setup();
    openPicker();
    expect(screen.getByRole('button', { name: 'Done editing Claude Code models' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('searchbox', { name: /Search Claude Code models/ })).toHaveFocus();
    expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(within(option(/Opus 4\.1/)).getByText('claude-opus-4-1')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('All 4 allowed');
  });

  it('filters by label or id as you type, ignoring case, and clears', () => {
    setup();
    openPicker();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'SONNET' } });
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.allowlist-label')?.textContent)).toEqual(['Sonnet 4.5']);

    fireEvent.change(search, { target: { value: 'haiku-4' } });
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.allowlist-label')?.textContent)).toEqual(['Haiku 4.5']);

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByText(/No model matches/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });

  it('ticks models and sends one write for the lot after a pause, in the order they were ticked', async () => {
    const { onCommit } = setup();
    openPicker();
    fireEvent.click(option(/Sonnet/));
    fireEvent.click(option(/Opus/));
    fireEvent.click(option(/Haiku/));
    expect(selectedNames()).toEqual(['Opus 4.1', 'Sonnet 4.5', 'Haiku 4.5']);
    expect(screen.getByRole('status')).toHaveTextContent('3 of 4 allowed');
    expect(onCommit).not.toHaveBeenCalled();

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith(['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5']);
    expect(ALLOWLIST_DEBOUNCE_MS).toBeLessThan(2000);
  });

  it('sends what is ticked at once when the picker closes', () => {
    const { onCommit } = setup({ ids: ['claude-opus-4-1'] });
    openPicker();
    fireEvent.click(option(/Haiku/));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done editing Claude Code models' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(['claude-opus-4-1', 'claude-haiku-4-5']);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('sends null when the last model is unticked, and says every model is allowed again', async () => {
    const { onCommit } = setup({ ids: ['claude-opus-4-1'] });
    openPicker();
    fireEvent.click(option(/Opus/));
    expect(screen.getByRole('status')).toHaveTextContent('All 4 allowed');
    fireEvent.click(screen.getByRole('button', { name: 'Done editing Claude Code models' }));
    expect(onCommit).toHaveBeenCalledWith(null);
    expect(screen.getByText('All models')).toBeInTheDocument();
    expect(screen.queryByText(/Untick every model/)).not.toBeInTheDocument();
  });

  it('explains in a hint that unticking everything allows every model', () => {
    setup();
    openPicker();
    expect(screen.getByText(/Untick every model to allow all of them/)).toBeInTheDocument();
  });

  it('Allow all models clears the allowlist at once, dropping ticks not yet sent', async () => {
    const { onCommit } = setup({ ids: ['claude-opus-4-1', 'claude-haiku-4-5'] });
    openPicker();
    fireEvent.click(option(/Sonnet/));
    fireEvent.click(screen.getByRole('button', { name: 'Allow all models' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(null);
    expect(selectedNames()).toEqual([]);
    // The tick made before it must not be sent later.
    await new Promise((resolve) => setTimeout(resolve, ALLOWLIST_DEBOUNCE_MS + 150));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('disables Allow all models while nothing is ticked', () => {
    setup();
    openPicker();
    expect(screen.getByRole('button', { name: 'Allow all models' })).toBeDisabled();
    fireEvent.click(option(/Opus/));
    expect(screen.getByRole('button', { name: 'Allow all models' })).toBeEnabled();
  });

  it('shows an allowed model the runner no longer lists first, marked, so it can be removed', () => {
    const { onCommit } = setup({ ids: ['claude-haiku-4-5', 'claude-retired-3'] });
    openPicker();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(5);
    expect(options[0]).toHaveTextContent('claude-retired-3');
    expect(options[0]).toHaveTextContent('Not listed by this runner');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/2 of 5 models: Haiku 4\.5, claude-retired-3/)).toBeInTheDocument();

    fireEvent.click(options[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Done editing Claude Code models' }));
    expect(onCommit).toHaveBeenCalledWith(['claude-haiku-4-5']);
  });

  it('keeps the ticks made while a write is answered, and falls back to the host\'s state once it is', async () => {
    let answer: () => void = () => undefined;
    const onCommit = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    setup({ ids: ['claude-opus-4-1'], onCommit });
    openPicker();
    fireEvent.click(option(/Sonnet/));
    fireEvent.click(screen.getByRole('button', { name: 'Done editing Claude Code models' }));
    expect(screen.getByText(/2 of 4 models/)).toBeInTheDocument();
    // The host refuses: its `ids` stay as they were.
    answer();
    await waitFor(() => expect(screen.getByText(/^1 of 4 models: Opus 4\.1$/)).toBeInTheDocument());
  });

  it('shows what the host answered with when its allowlist changes', () => {
    const { rerender } = setup({ ids: ['claude-opus-4-1'] });
    rerender(['claude-haiku-4-5']);
    expect(screen.getByText('1 of 4 models: Haiku 4.5')).toBeInTheDocument();
  });

  it('says so when the runner lists no models', () => {
    setup({ models: [] });
    openPicker();
    expect(screen.getByText('Claude Code lists no models.')).toBeInTheDocument();
  });

  it("gives the runner's own reason when it lists nothing, in place of the generic line", () => {
    setup({ models: [], error: 'Claude Code is not signed in. Run claude auth login.' });
    openPicker();
    expect(screen.getByText('Claude Code is not signed in. Run claude auth login.')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code lists no models.')).toBeNull();
  });
});

describe('a model row', () => {
  it('prints the id once when the runner labels the model by that same id', () => {
    setup({ models: [{ modelId: 'deepseek-v4.1-flash', modelLabel: 'deepseek-v4.1-flash', variants: [] }] });
    openPicker();
    const row = option(/deepseek-v4\.1-flash/);
    expect(within(row).getAllByText('deepseek-v4.1-flash')).toHaveLength(1);
    expect(row.querySelector('.allowlist-id')).toBeNull();
  });

  it('omits an id that repeats the label after its last slash', () => {
    setup({ models: [{ modelId: 'opencode-go/deepseek-v4.1-flash', modelLabel: 'deepseek-v4.1-flash', variants: [] }] });
    openPicker();
    const row = option(/deepseek-v4\.1-flash/);
    expect(within(row).getAllByText('deepseek-v4.1-flash')).toHaveLength(1);
    expect(row.querySelector('.allowlist-id')).toBeNull();
  });

  it('prints a differing id beside the label, with the full id as its title', () => {
    setup({ models: [{ modelId: 'opencode-go/deepseek-v4.1-flash', modelLabel: 'DeepSeek V4.1 Flash', variants: [] }] });
    openPicker();
    const row = option(/DeepSeek V4\.1 Flash/);
    expect(row.querySelector('.allowlist-label')).toHaveTextContent('DeepSeek V4.1 Flash');
    const id = row.querySelector('.allowlist-id');
    expect(id).toHaveTextContent('opencode-go/deepseek-v4.1-flash');
    expect(id).toHaveAttribute('title', 'opencode-go/deepseek-v4.1-flash');
  });

  it('distinguishes shared labels in the rows and summary, including retained models', () => {
    const models = [
      { modelId: 'opencode-go/flash', modelLabel: 'flash', variants: [] },
      { modelId: 'openrouter/flash', modelLabel: 'flash', variants: [] },
      { modelId: 'vendor/old', modelLabel: 'missing/old', variants: [] },
      { modelId: 'vendor/unique', modelLabel: 'unique', variants: [] },
    ];
    setup({ models, ids: ['opencode-go/flash', 'openrouter/flash', 'missing/old'] });
    expect(screen.getByText('3 of 5 models: opencode-go/flash, openrouter/flash, +1')).toBeInTheDocument();
    openPicker();
    const rows = screen.getAllByRole('option');
    for (const id of ['opencode-go/flash', 'openrouter/flash', 'missing/old', 'vendor/old']) {
      const row = rows.find((candidate) => candidate.querySelector('.allowlist-id')?.getAttribute('title') === id);
      expect(row).toBeDefined();
      expect(row?.textContent?.split(id)).toHaveLength(2);
    }
    expect(rows.find((row) => row.querySelector('.allowlist-label')?.textContent === 'unique')?.querySelector('.allowlist-id')).toBeNull();
  });
});

describe('the keyboard', () => {
  it('moves through the list with the arrow keys, toggles with Space or Enter, and goes back to the search with ArrowUp', () => {
    setup();
    openPicker();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(list).toHaveFocus();
    expect(list).toHaveAttribute('aria-activedescendant', option(/Opus/).id);

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list).toHaveAttribute('aria-activedescendant', option(/Sonnet/).id);
    fireEvent.keyDown(list, { key: ' ' });
    expect(selectedNames()).toEqual(['Sonnet 4.5']);
    fireEvent.keyDown(list, { key: 'End' });
    expect(list).toHaveAttribute('aria-activedescendant', option(/Bedrock/).id);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list).toHaveAttribute('aria-activedescendant', option(/Bedrock/).id);
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(selectedNames()).toEqual(['Opus 4.1', 'Sonnet 4.5']);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });

  it('walks only the models the search leaves', () => {
    setup();
    openPicker();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '4-5' } });
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list).toHaveAttribute('aria-activedescendant', option(/Haiku/).id);
  });

  it('closes on Escape, sends the ticks and returns focus to its toggle', () => {
    const { onCommit } = setup();
    openPicker();
    fireEvent.click(option(/Opus/));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Claude Code models' })).toHaveFocus();
    expect(onCommit).toHaveBeenCalledWith(['claude-opus-4-1']);
  });
});

describe('a disabled runner', () => {
  it('still shows its summary but cannot be edited', () => {
    setup({ ids: ['claude-opus-4-1'], disabled: true });
    expect(screen.getByText('1 of 4 models: Opus 4.1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Claude Code models' })).toBeDisabled();
  });
});
