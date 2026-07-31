import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { DiscoveredModel, TaskModelAssignment } from '@ordewell/core';

type ApiProvider = 'openrouter' | 'google' | 'openai_compatible' | 'openai' | 'xai' | 'groq' | 'deepseek' | 'together' | 'mistral' | 'anthropic' | 'fireworks' | 'perplexity' | 'zhipu' | 'kimi' | 'cerebras' | 'deepinfra' | 'doubao' | 'qwen' | 'hunyuan' | 'baichuan' | 'minimax' | 'yi' | 'stepfun' | 'siliconflow' | 'cohere' | 'novita';

interface ModelSelectorProps {
  models: DiscoveredModel[];
  currentModel: TaskModelAssignment | undefined;
  onChange: (assignment: TaskModelAssignment) => void;
  configuredProviders?: ApiProvider[];
  modelApiMapping?: Record<string, ApiProvider[]>;
  label?: string;
}

export const API_PROVIDER_LABELS: Record<ApiProvider, string> = {
  openrouter: 'OpenRouter',
  google: 'Gemini',
  openai_compatible: 'Custom',
  openai: 'OpenAI',
  xai: 'xAI',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  together: 'Together',
  mistral: 'Mistral',
  anthropic: 'Anthropic',
  fireworks: 'Fireworks',
  perplexity: 'Perplexity',
  zhipu: 'Zhipu',
  kimi: 'Kimi',
  cerebras: 'Cerebras',
  deepinfra: 'DeepInfra',
  doubao: 'Doubao',
  qwen: 'Qwen',
  hunyuan: 'Hunyuan',
  baichuan: 'Baichuan',
  minimax: 'MiniMax',
  yi: 'Yi',
  stepfun: 'StepFun',
  siliconflow: 'SiliconFlow',
  cohere: 'Cohere',
  novita: 'Novita',
};

// Named model-family → CSS class for explicit known families
const KNOWN_FAMILY_CLASSES: Record<string, string> = {
  sonnet: 'model-sonnet',
  opus: 'model-opus',
  haiku: 'model-haiku',
  deepseek: 'model-deepseek',
  kimi: 'model-kimi',
  gpt: 'model-gpt',
  gemini: 'model-gemini',
  qwen: 'model-qwen',
  glm: 'model-glm',
  minimax: 'model-minimax',
  mimo: 'model-mimo',
  fable: 'model-fable',
};

function knownFamilyClass(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  for (const [key, cls] of Object.entries(KNOWN_FAMILY_CLASSES)) {
    if (lower.includes(key)) return cls;
  }
  return null;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const HASH_PALETTE_COUNT = 8;

function hashModelClass(modelId: string): string {
  // Hash based on the provider/family part for stability across model versions
  const base = modelId.split('/')[0] || modelId.split('-')[0] || modelId;
  return `model-hash-${hashString(base) % HASH_PALETTE_COUNT}`;
}

export function getModelClass(modelId: string): string {
  if (!modelId) return '';
  return knownFamilyClass(modelId) ?? hashModelClass(modelId);
}

/** The backend a model is served by, as its source reported it. */
function backendOf(m: DiscoveredModel): string {
  return m.runnerProvider || (m.modelId.includes('/') ? m.modelId.split('/')[0] : 'Other');
}

/**
 * Header for one group: the runner that would actually be spawned, then the
 * backend serving the model — "OpenCode · openrouter". A runner's catalog names
 * its backends, not itself (OpenCode reports 339 of its 414 models as
 * `openrouter`), so the backend alone never told the user which agent runs it.
 * Vendor-catalog models have no runner, and keep the plain provider label.
 */
export function groupHeader(m: DiscoveredModel): string {
  const backend = providerLabel(backendOf(m), m.runnerProviderLabel);
  return m.runnerLabel ? `${m.runnerLabel} · ${backend}` : backend;
}

export interface ModelGroup {
  header: string;
  models: DiscoveredModel[];
  /** No model here mapped to a configured API provider — kept visible through pill filtering. */
  allUnknown: boolean;
}

/**
 * One group per (runner, backend) pair, in first-seen order. Known and unknown
 * models share a group: keying them into two maps rendered the same header
 * twice whenever a provider had some of each.
 */
function groupModels(models: DiscoveredModel[], isUnknown: (m: DiscoveredModel) => boolean): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const m of models) {
    const header = groupHeader(m);
    let group = groups.get(header);
    if (!group) {
      group = { header, models: [], allUnknown: true };
      groups.set(header, group);
    }
    group.models.push(m);
    if (!isUnknown(m)) group.allUnknown = false;
  }
  return [...groups.values()];
}

/**
 * Display name for a runner provider: the label the source reported
 * (`runnerProviderLabel`), else the key exactly as a runner CLI lists it
 * (`opencode`, `opencode-go`) — no renaming, no title-casing. The planner
 * dropdown supplies its own reported label (the API-provider name) via
 * `runnerProviderLabel`, so it never falls through to the raw key here.
 */
export function providerLabel(key: string, reported?: string): string {
  return reported || key;
}

export default function ModelSelector({
  models,
  currentModel,
  onChange,
  configuredProviders = [],
  modelApiMapping = {},
  label = 'Model',
}: ModelSelectorProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ApiProvider | null>(
    configuredProviders[0] ?? null,
  );
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });

  // Snapshot of the model set taken when the dropdown opens.
  const [frozen, setFrozen] = useState<{
    models: DiscoveredModel[];
    mapping: Record<string, ApiProvider[]>;
  } | null>(null);
  const viewModels = frozen?.models ?? models;
  const viewMapping = frozen?.mapping ?? modelApiMapping;

  const triggerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && searchInputRef.current) {
      searchInputRef.current.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (
        dropdownRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
      setFrozen(null);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  const handleToggle = () => {
    if (!open) {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        setDropdownPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
      }
      setFrozen({ models, mapping: modelApiMapping });
    } else {
      setFrozen(null);
    }
    setOpen((v) => !v);
  };

  const showPillBar = configuredProviders.length >= 2;
  const activeProvider = showPillBar ? selectedProvider : null;

  const isUnknown = (modelId: string): boolean => {
    const m = viewMapping[modelId];
    return !m || m.length === 0;
  };

  const groups = useMemo(() => {
    const matchesSearch = (m: DiscoveredModel) =>
      !search ||
      m.modelLabel.toLowerCase().includes(search.toLowerCase()) ||
      m.modelId.toLowerCase().includes(search.toLowerCase());

    // An unmapped model is shown whatever the pill selection: the mapping only
    // covers the vendor catalog, so a runner's own models are all "unknown" and
    // filtering them out would empty the picker.
    const visible = viewModels.filter((m) =>
      matchesSearch(m) &&
      (isUnknown(m.modelId) || activeProvider === null || viewMapping[m.modelId].includes(activeProvider)),
    );
    return groupModels(visible, (m) => isUnknown(m.modelId));
  }, [viewModels, search, activeProvider, viewMapping]);

  const selectedModel = models.find((m) => m.modelId === currentModel?.modelId);
  // An assignment whose model isn't in the discovered list (degraded/partial
  // discovery) is still real — the spawn will pass it. Show it rather than
  // pretending nothing is assigned.
  const triggerText = selectedModel
    ? `${selectedModel.modelLabel} · ${providerLabel(selectedModel.runnerProvider || selectedModel.modelId.split('/')[0] || '', selectedModel.runnerProviderLabel)}`
    : currentModel
      ? currentModel.modelId.includes('/')
        ? `${currentModel.modelLabel} · ${providerLabel(currentModel.modelId.split('/')[0])}`
        : currentModel.modelLabel
      : 'Select model...';
  const triggerClass = selectedModel
    ? getModelClass(selectedModel.modelId)
    : currentModel
      ? getModelClass(currentModel.modelId)
      : '';

  const closeDropdown = () => {
    setOpen(false);
    setFrozen(null);
  };

  const handleSelect = (model: DiscoveredModel) => {
    // Carry the effort over only when the new model actually offers it;
    // otherwise fall back to the runner default so the badge never claims a
    // variant the session won't use.
    const carried = currentModel?.thinkingEffort;
    const valid = carried && model.variants.some((v) => v.id === carried);
    onChange({
      modelId: model.modelId,
      modelLabel: model.modelLabel,
      thinkingEffort: valid ? carried : undefined,
      availableVariants: model.variants.map((v) => v.id),
    });
    setSearch('');
    closeDropdown();
  };

  const renderModelItem = (m: DiscoveredModel) => (
    <div
      key={m.modelId}
      className={`model-picker-item ${m.modelId === currentModel?.modelId ? 'selected' : ''} ${getModelClass(m.modelId)}`}
      onClick={() => handleSelect(m)}
      title={`${m.modelLabel}\n${m.modelId}`}
    >
      <span className="model-picker-item-label">{m.modelLabel}</span>
      <span className="model-picker-item-id">{providerLabel(m.runnerProvider || m.modelId.split('/')[0] || '', m.runnerProviderLabel)}</span>
    </div>
  );

  return (
    <div className="model-selector">
      <label>{label}</label>
      <div className="model-selector-row">
        <div className="model-picker">
          <div
            ref={triggerRef}
            className="model-picker-trigger"
            onClick={handleToggle}
          >
            <span className={`model-picker-label ${triggerClass}`}>
              {triggerText}
            </span>
            <span className={`model-picker-arrow ${open ? 'open' : ''}`}>&#9660;</span>
          </div>
          {open && (
            <div
              ref={dropdownRef}
              className="model-picker-dropdown"
              style={{
                position: 'fixed',
                top: dropdownPos.top,
                left: dropdownPos.left,
                width: dropdownPos.width,
              }}
            >
              {showPillBar && (
                <div className="model-picker-pills" data-testid="provider-pill-bar">
                  {configuredProviders.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`provider-pill ${selectedProvider === p ? 'active' : ''}`}
                      onClick={() =>
                        setSelectedProvider((prev) => (prev === p ? null : p))
                      }
                    >
                      {API_PROVIDER_LABELS[p]}
                    </button>
                  ))}
                </div>
              )}
              <div className="model-picker-search">
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search models..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSearch('');
                      closeDropdown();
                    }
                  }}
                />
              </div>
              <div className="model-picker-list">
                {groups.map((group) => (
                  <div
                    key={group.header}
                    className="model-picker-group"
                    {...(group.allUnknown ? { 'data-testid': 'unknown-provider-group' } : {})}
                  >
                    <div className="model-picker-group-header">{group.header}</div>
                    {group.models.map(renderModelItem)}
                  </div>
                ))}
                {groups.length === 0 && (
                  <div className="model-picker-empty">No models found</div>
                )}
              </div>
            </div>
          )}
        </div>

        {selectedModel && selectedModel.variants.length > 0 && (
          <select
            className="variant-select"
            // The value must reflect what the runner will actually receive:
            // unset (or invalid for this model) renders as "Default" instead
            // of silently displaying a variant that was never assigned.
            value={
              currentModel?.thinkingEffort && selectedModel.variants.some((v) => v.id === currentModel.thinkingEffort)
                ? currentModel.thinkingEffort
                : ''
            }
            onChange={(e) => {
              if (currentModel) {
                onChange({
                  ...currentModel,
                  thinkingEffort: (e.target.value || undefined) as TaskModelAssignment['thinkingEffort'],
                  availableVariants: selectedModel.variants.map((v) => v.id),
                });
              }
            }}
          >
            <option value="">Default</option>
            {selectedModel.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
