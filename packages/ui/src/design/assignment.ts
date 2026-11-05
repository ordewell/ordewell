/**
 * The words for a task's model and thinking effort, shared by every surface
 * that names them (the plan list's row, the task card, the graph), so one
 * assignment never reads two ways. The runner's words are in `runners.tsx`.
 */

/** An AI task with no model runs its runner's default; the label says so rather than showing nothing. */
export const DEFAULT_MODEL_LABEL = 'default model';

/** The model as the plan names it: its label, else its id. */
export function modelLabel(model: { modelId?: string; modelLabel?: string } | null | undefined): string {
  return model?.modelLabel || model?.modelId || DEFAULT_MODEL_LABEL;
}

/**
 * The model without its provider, for a line too narrow for the whole name:
 * "deepseek-v4.1-flash" for "opencode-go/deepseek-v4.1-flash". The provider is
 * the part a reader needs least once the runner beside it is named.
 */
export function modelShortLabel(label: string): string {
  const cut = label.lastIndexOf('/');
  return cut > 0 && cut < label.length - 1 ? label.slice(cut + 1) : label;
}

/**
 * Efforts are a runner's own variant ids, so one Ordewell has no word for
 * keeps its id. The long form is a phrase; the short one is never cut mid-word.
 */
const EFFORT_WORDS: Readonly<Record<string, { long: string; short: string }>> = {
  none: { long: 'none', short: 'none' },
  minimal: { long: 'minimal', short: 'min' },
  low: { long: 'low', short: 'low' },
  medium: { long: 'medium', short: 'med' },
  high: { long: 'high', short: 'high' },
  xhigh: { long: 'extra high', short: 'xhigh' },
  max: { long: 'max', short: 'max' },
  ultra: { long: 'ultra', short: 'ultra' },
  adaptive: { long: 'adaptive', short: 'adapt' },
};

/** A thinking effort in words: "extra high" for `xhigh`; `short` for a narrow line, with the long form kept for its tooltip. */
export function effortLabel(effort: string, options: { short?: boolean } = {}): string {
  const words = Object.hasOwn(EFFORT_WORDS, effort) ? EFFORT_WORDS[effort] : undefined;
  if (!words) return effort;
  return options.short ? words.short : words.long;
}
