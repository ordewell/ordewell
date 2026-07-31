export interface ModelShortcut {
  label: string;
  id: string;
  provider: string;
  description: string;
  pricing?: string;
}

export function extractProvider(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash < 0) return '';
  return modelId.slice(0, slash);
}

export function groupByProvider<T extends { id: string }>(items: T[], extract?: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const provider = extract ? extract(item) : extractProvider(item.id);
    const key = provider || 'Other';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(item);
  }
  return grouped;
}

export const ORCHESTRATOR_SHORTCUTS: ModelShortcut[] = [
  { label: 'DeepSeek V4 Flash', id: 'deepseek/deepseek-v4-flash', provider: 'OpenRouter', description: 'Best all-around — strong coding, cheap', pricing: '0.09/0.18' },
  { label: 'DeepSeek R1', id: 'deepseek/deepseek-r1', provider: 'OpenRouter', description: 'Reasoning model — complex logic, zero-cost thinking tokens', pricing: '0.55/2.19' },
  { label: 'Claude Sonnet 4', id: 'anthropic/claude-sonnet-4', provider: 'OpenRouter', description: 'Top-tier reasoning, careful editing', pricing: '3/15' },
  { label: 'Claude Opus 4', id: 'anthropic/claude-opus-4.7', provider: 'OpenRouter', description: 'Strongest overall — complex refactoring, architecture', pricing: '15/75' },
  { label: 'GPT-4o', id: 'openai/gpt-4o', provider: 'OpenRouter', description: 'General purpose, strong multimodal', pricing: '2.50/10' },
  { label: 'GPT-4.1', id: 'openai/gpt-4.1', provider: 'OpenRouter', description: 'Latest GPT — strong coding, 1M context', pricing: '2/8' },
  { label: 'Kimi K2.6', id: 'moonshot/kimi-k2.6', provider: 'OpenRouter', description: 'Strong coding, cheap', pricing: '0.60/2.40' },
  { label: 'Qwen 3 Max', id: 'qwen/qwen3-max', provider: 'OpenRouter', description: 'Strong open model', pricing: '0.80/3.20' },
];

export function resolveModelShortcut(input: string, shortcuts: ModelShortcut[]): string | null {
  for (const s of shortcuts) {
    if (s.id === input) return s.id;
    if (s.label.toLowerCase() === input.toLowerCase()) return s.id;
  }
  return null;
}

/**
 * Resolves a value to a model id ONLY when it is in the supplied catalog
 * option list — either directly or via a shortcut label. Free-typed, unknown,
 * or not-currently-available values return null, so callers never store an id
 * the user couldn't have selected from the list. Keeps model-setting list-only.
 */
export function knownModelId(value: string, optionIds: string[], shortcuts: ModelShortcut[]): string | null {
  if (!value) return null;
  const viaShortcut = resolveModelShortcut(value, shortcuts);
  if (viaShortcut && optionIds.includes(viaShortcut)) return viaShortcut;
  return optionIds.includes(value) ? value : null;
}
