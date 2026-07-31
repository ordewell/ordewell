import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ModelSelector from '../ModelSelector';
import type { DiscoveredModel } from '@ordewell/core';

function model(modelId: string, modelLabel = modelId, runnerProvider?: string): DiscoveredModel {
  return { modelId, modelLabel, runnerProvider, variants: [] };
}

const MODELS: DiscoveredModel[] = [
  model('openai/gpt-4o', 'GPT-4o'),
  model('anthropic/claude-sonnet-4', 'Claude Sonnet 4'),
  model('google/gemini-2.5-pro', 'Gemini 2.5 Pro'),
  model('local/mystery-model', 'Mystery'),
];

const MAPPING: Record<string, ('openrouter' | 'google')[]> = {
  'openai/gpt-4o': ['openrouter'],
  'anthropic/claude-sonnet-4': ['openrouter'],
  'google/gemini-2.5-pro': ['google'],
  'local/mystery-model': [],
};

function renderSelector(props: Partial<React.ComponentProps<typeof ModelSelector>> = {}) {
  return render(
    <ModelSelector
      models={MODELS}
      currentModel={undefined}
      onChange={props.onChange ?? vi.fn()}
      configuredProviders={props.configuredProviders ?? ['openrouter', 'google']}
      modelApiMapping={props.modelApiMapping ?? MAPPING}
    />,
  );
}

/** Open the model picker dropdown so its contents (pills, search, list) render. */
function openDropdown() {
  fireEvent.click(screen.getByText('Select model...'));
}

describe('ModelSelector provider pill bar', () => {
  it('renders one pill per configured provider when there are 2', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    const pillBar = screen.getByTestId('provider-pill-bar');
    expect(within(pillBar).getByRole('button', { name: /openrouter/i })).toBeInTheDocument();
    expect(within(pillBar).getByRole('button', { name: /gemini/i })).toBeInTheDocument();
  });

  it('hides the pill bar when only one provider is configured', () => {
    renderSelector({ configuredProviders: ['openrouter'] });
    openDropdown();
    expect(screen.queryByTestId('provider-pill-bar')).not.toBeInTheDocument();
  });

  it('hides the pill bar when no providers are configured', () => {
    renderSelector({ configuredProviders: [] });
    openDropdown();
    expect(screen.queryByTestId('provider-pill-bar')).not.toBeInTheDocument();
  });

  it('defaults to the first provider and filters the list to its models', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    // OpenRouter models shown
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    // Gemini model hidden (only available via google)
    expect(screen.queryByText('Gemini 2.5 Pro')).not.toBeInTheDocument();
  });

  it('clicking the Gemini pill filters the list to Gemini models', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    fireEvent.click(screen.getByRole('button', { name: /gemini/i }));
    expect(screen.getByText('Gemini 2.5 Pro')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
  });

  it('highlights the active pill', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    expect(screen.getByRole('button', { name: /openrouter/i }).className).toContain('active');
    expect(screen.getByRole('button', { name: /gemini/i }).className).not.toContain('active');
    fireEvent.click(screen.getByRole('button', { name: /gemini/i }));
    expect(screen.getByRole('button', { name: /gemini/i }).className).toContain('active');
    expect(screen.getByRole('button', { name: /openrouter/i }).className).not.toContain('active');
  });

  it('clicking the active pill deselects it and shows all models', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    // default-selected openrouter hides Gemini
    expect(screen.queryByText('Gemini 2.5 Pro')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /openrouter/i }));
    // now nothing is selected -> all known models from all providers visible
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('Gemini 2.5 Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /openrouter/i }).className).not.toContain('active');
  });

  it('shows unknown-provider models in the catch-all group regardless of pill selection', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    // default selection is openrouter; mystery has empty mapping
    const unknownGroup = screen.getByTestId('unknown-provider-group');
    expect(within(unknownGroup).getByText('Mystery')).toBeInTheDocument();
    // switch to gemini -> mystery still present
    fireEvent.click(screen.getByRole('button', { name: /gemini/i }));
    expect(within(screen.getByTestId('unknown-provider-group')).getByText('Mystery')).toBeInTheDocument();
  });

  it('preserves search text when switching pills and re-filters', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'] });
    openDropdown();
    const searchInput = screen.getByPlaceholderText('Search models...');
    fireEvent.change(searchInput, { target: { value: 'claude' } });
    // openrouter selected + search 'claude' -> only Claude Sonnet
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(screen.queryByText('GPT-4o')).not.toBeInTheDocument();
    // switch to gemini: search text retained, no gemini model matches 'claude'
    fireEvent.click(screen.getByRole('button', { name: /gemini/i }));
    expect((screen.getByPlaceholderText('Search models...') as HTMLInputElement).value).toBe('claude');
    expect(screen.queryByText('Gemini 2.5 Pro')).not.toBeInTheDocument();
  });

  it('shows all models before the mapping arrives (empty mapping)', () => {
    renderSelector({ configuredProviders: ['openrouter', 'google'], modelApiMapping: {} });
    openDropdown();
    // every model is "unknown" until the mapping lands, so all are visible
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('Gemini 2.5 Pro')).toBeInTheDocument();
    expect(screen.getByText('Mystery')).toBeInTheDocument();
  });
});

describe('ModelSelector runnerProvider grouping', () => {
  it('groups models by runnerProvider field when set, using provider labels', () => {
    const models: DiscoveredModel[] = [
      model('any/deepseek-v4-flash', 'DeepSeek V4 Flash', 'opencode'),
      model('other/deepseek-v4-flash', 'DeepSeek V4 Flash', 'opencode-go'),
    ];
    const mapping: Record<string, ('openrouter' | 'google')[]> = {
      'any/deepseek-v4-flash': ['openrouter'],
      'other/deepseek-v4-flash': ['openrouter'],
    };
    render(
      <ModelSelector
        models={models}
        currentModel={undefined}
        onChange={vi.fn()}
        configuredProviders={['openrouter']}
        modelApiMapping={mapping}
      />,
    );
    openDropdown();
    // Provider labels are verbatim — exactly what the runner CLI lists.
    expect(screen.getAllByText('opencode').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('opencode-go').length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to "Other" when runnerProvider is undefined', () => {
    const models: DiscoveredModel[] = [
      model('sonnet', 'Claude Sonnet'),
    ];
    const mapping: Record<string, ('openrouter' | 'google')[]> = {
      'sonnet': ['openrouter'],
    };
    render(
      <ModelSelector
        models={models}
        currentModel={undefined}
        onChange={vi.fn()}
        configuredProviders={['openrouter']}
        modelApiMapping={mapping}
      />,
    );
    openDropdown();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('shows every runner provider group when discovery returns multiple providers', () => {
    const models: DiscoveredModel[] = [
      { modelId: 'opencode/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro', runnerProvider: 'opencode', variants: [{ id: 'low', label: 'Low' }] },
      { modelId: 'opencode-go/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro (Go)', runnerProvider: 'opencode-go', variants: [{ id: 'low', label: 'Low' }] },
      { modelId: 'openrouter/~anthropic/claude-sonnet-latest', modelLabel: 'Claude Sonnet', runnerProvider: 'openrouter', variants: [] },
    ];
    render(
      <ModelSelector
        models={models}
        currentModel={undefined}
        onChange={vi.fn()}
        configuredProviders={[]}
        modelApiMapping={{}}
      />,
    );
    openDropdown();
    expect(screen.getAllByText('opencode').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('opencode-go').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('openrouter').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('DeepSeek V4 Pro (Go)')).toBeInTheDocument();
  });

  it('shows runnerProvider label as secondary text instead of modelId', () => {
    const models: DiscoveredModel[] = [
      model('x-custom/deepseek-v4-flash', 'DeepSeek V4 Flash', 'opencode-go'),
    ];
    const mapping: Record<string, ('openrouter' | 'google')[]> = {
      'x-custom/deepseek-v4-flash': ['openrouter'],
    };
    render(
      <ModelSelector
        models={models}
        currentModel={undefined}
        onChange={vi.fn()}
        configuredProviders={['openrouter']}
        modelApiMapping={mapping}
      />,
    );
    openDropdown();
    const items = screen.getAllByText('opencode-go');
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('x-custom/deepseek-v4-flash')).not.toBeInTheDocument();
  });

  it('names the runner before the backend, so a catalog that reports "openrouter" still says which agent runs it', () => {
    const models: DiscoveredModel[] = [
      { modelId: 'opencode/claude-opus-5', modelLabel: 'Claude Opus 5', runnerProvider: 'opencode', runnerId: 'opencode', runnerLabel: 'OpenCode', variants: [] },
      { modelId: 'openrouter/anthropic/claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', runnerProvider: 'openrouter', runnerId: 'opencode', runnerLabel: 'OpenCode', variants: [] },
      { modelId: 'sonnet', modelLabel: 'Sonnet', runnerProvider: 'anthropic', runnerId: 'claude-code', runnerLabel: 'Claude Code', variants: [] },
    ];
    render(
      <ModelSelector models={models} currentModel={undefined} onChange={vi.fn()} configuredProviders={[]} modelApiMapping={{}} />,
    );
    openDropdown();
    expect(screen.getByText('OpenCode · opencode')).toBeInTheDocument();
    expect(screen.getByText('OpenCode · openrouter')).toBeInTheDocument();
    expect(screen.getByText('Claude Code · anthropic')).toBeInTheDocument();
  });

  it('renders one header per provider when some of its models are mapped and some are not', () => {
    // The mapped/unmapped split used to be two separate group maps, so a
    // provider holding one of each printed its header twice.
    const models: DiscoveredModel[] = [
      model('openrouter/known', 'Known', 'openrouter'),
      model('openrouter/unmapped', 'Unmapped', 'openrouter'),
    ];
    render(
      <ModelSelector
        models={models}
        currentModel={undefined}
        onChange={vi.fn()}
        configuredProviders={['openrouter']}
        modelApiMapping={{ 'openrouter/known': ['openrouter'], 'openrouter/unmapped': [] }}
      />,
    );
    openDropdown();
    const headers = document.querySelectorAll('.model-picker-group-header');
    expect([...headers].map((h) => h.textContent)).toEqual(['openrouter']);
    expect(screen.getByText('Known')).toBeInTheDocument();
    expect(screen.getByText('Unmapped')).toBeInTheDocument();
  });

  it('labels planner-dropdown models by their API provider (runnerProviderLabel), not the id prefix', () => {
    // How App.tsx builds orchestrator options: runnerProvider = apiProvider,
    // runnerProviderLabel = the API-provider display name. A prefixed id
    // (openai:gpt-4o) must show "OpenAI", not "openai:gpt-4o".
    const models: DiscoveredModel[] = [
      { modelId: 'openai:gpt-4o', modelLabel: 'GPT-4o', runnerProvider: 'openai', runnerProviderLabel: 'OpenAI', variants: [] },
    ];
    render(
      <ModelSelector
        models={models}
        currentModel={undefined}
        onChange={vi.fn()}
        configuredProviders={['openai']}
        modelApiMapping={{ 'openai:gpt-4o': ['openai'] }}
      />,
    );
    openDropdown();
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('openai:gpt-4o')).not.toBeInTheDocument();
  });
});

describe('ModelSelector thinking variants', () => {
  const withVariants = (modelId: string, label: string, ids: string[]): DiscoveredModel => ({
    modelId,
    modelLabel: label,
    runnerProvider: modelId.split('/')[0],
    variants: ids.map((id) => ({ id, label: id })),
  });

  const VARIANT_MODELS = [
    withVariants('p/rich', 'Rich', ['low', 'medium', 'high', 'xhigh', 'max']),
    withVariants('p/limited', 'Limited', ['low', 'high']),
    { ...model('p/plain', 'Plain', 'p') },
  ];

  function renderWithCurrent(current: { modelId: string; modelLabel: string; thinkingEffort?: string } | undefined, onChange = vi.fn()) {
    render(
      <ModelSelector
        models={VARIANT_MODELS}
        currentModel={current}
        onChange={onChange}
        configuredProviders={[]}
        modelApiMapping={{ 'p/rich': ['openrouter'], 'p/limited': ['openrouter'], 'p/plain': ['openrouter'] }}
      />,
    );
  }

  it('preselects the assigned thinking effort in the variant select', () => {
    renderWithCurrent({ modelId: 'p/rich', modelLabel: 'Rich', thinkingEffort: 'xhigh' });
    expect(screen.getByRole('combobox')).toHaveValue('xhigh');
  });

  it('shows Default when no effort is assigned instead of faking the first variant', () => {
    renderWithCurrent({ modelId: 'p/rich', modelLabel: 'Rich' });
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('shows Default when the assigned effort is not a variant of the model', () => {
    renderWithCurrent({ modelId: 'p/limited', modelLabel: 'Limited', thinkingEffort: 'xhigh' });
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('renders no variant select for a model without variants', () => {
    renderWithCurrent({ modelId: 'p/plain', modelLabel: 'Plain' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('drops an effort the new model does not support when switching models', () => {
    const onChange = vi.fn();
    renderWithCurrent({ modelId: 'p/rich', modelLabel: 'Rich', thinkingEffort: 'xhigh' }, onChange);
    fireEvent.click(screen.getByText(/Rich ·/));
    fireEvent.click(screen.getByText('Limited'));
    expect(onChange).toHaveBeenCalledWith({ modelId: 'p/limited', modelLabel: 'Limited', thinkingEffort: undefined, availableVariants: ['low', 'high'] });
  });

  it('keeps the effort when the new model supports it', () => {
    const onChange = vi.fn();
    renderWithCurrent({ modelId: 'p/rich', modelLabel: 'Rich', thinkingEffort: 'high' }, onChange);
    fireEvent.click(screen.getByText(/Rich ·/));
    fireEvent.click(screen.getByText('Limited'));
    expect(onChange).toHaveBeenCalledWith({ modelId: 'p/limited', modelLabel: 'Limited', thinkingEffort: 'high', availableVariants: ['low', 'high'] });
  });

  it('clearing the select back to Default unsets the effort', () => {
    const onChange = vi.fn();
    renderWithCurrent({ modelId: 'p/rich', modelLabel: 'Rich', thinkingEffort: 'high' }, onChange);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ modelId: 'p/rich', modelLabel: 'Rich', thinkingEffort: undefined, availableVariants: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });
});

describe('ModelSelector assigned model missing from discovery', () => {
  it('shows the assignment instead of "Select model..." when the modelId is not in the list', () => {
    render(
      <ModelSelector
        models={MODELS}
        currentModel={{ modelId: 'opencode-go/deepseek-v4-flash', modelLabel: 'deepseek-v4-flash' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText('Select model...')).not.toBeInTheDocument();
    expect(screen.getByText('deepseek-v4-flash · opencode-go')).toBeInTheDocument();
  });

  it('shows just the label when the missing modelId has no provider prefix', () => {
    render(
      <ModelSelector
        models={MODELS}
        currentModel={{ modelId: 'bare-model', modelLabel: 'Bare Model' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Bare Model')).toBeInTheDocument();
  });

  it('still shows "Select model..." when nothing is assigned', () => {
    renderSelector();
    expect(screen.getByText('Select model...')).toBeInTheDocument();
  });
});
