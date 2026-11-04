import type { AcpConfigOption } from './acpSchema';

/**
 * Which of a session's config options is the mode, the model or the effort.
 * Pure: the options are whatever list the agent last gave, so a lookup is
 * made on each use and never cached across a `config_option_update`.
 */
export type OptionRole = 'mode' | 'model' | 'effort';

/**
 * The category is the specification's own marker, but only a hint for a user
 * interface, so an agent may leave it off; the ids are the ones agents are
 * seen to use. Effort has no single id: it is `effort`, `reasoning_effort` or
 * `reasoning` depending on the agent.
 */
const CATEGORY: Readonly<Record<OptionRole, string>> = { mode: 'mode', model: 'model', effort: 'thought_level' };
const IDS: Readonly<Record<OptionRole, readonly string[]>> = {
  mode: ['mode'],
  model: ['model'],
  effort: ['effort', 'reasoning_effort', 'reasoning', 'thought_level'],
};

/** A choice among values is the one type Ordewell can set; any other is left alone. */
export function findOption(options: readonly AcpConfigOption[], role: OptionRole): AcpConfigOption | undefined {
  const choices = options.filter((option) => option.type === 'select');
  return choices.find((option) => option.category === CATEGORY[role])
    ?? IDS[role].map((id) => choices.find((option) => option.id === id)).find((option) => option !== undefined);
}

/** The values an option accepts, groups flattened, with the name the agent shows for each. */
export function optionValues(option: AcpConfigOption): Array<{ value: string; name: string }> {
  const values: Array<{ value: string; name: string }> = [];
  for (const entry of option.options ?? []) {
    if (entry.options) for (const inner of entry.options) values.push({ value: inner.value, name: inner.name });
    else if (entry.value !== undefined) values.push({ value: entry.value, name: entry.name });
  }
  return values;
}

export function currentValue(option: AcpConfigOption | undefined): string | undefined {
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined;
}
