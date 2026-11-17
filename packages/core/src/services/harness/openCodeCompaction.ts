import type { AiProvider } from '../../interfaces/IConfig';
import { MODELS_DEV_PROVIDERS, modelDetails } from '../ModelDetails';
import { clampTaskCompactAt, type TaskCompactAt } from '../taskCompactWindow';
import { splitModelId } from './openCodeTransport';

/**
 * Room OpenCode 2.x keeps for a summary (`RESERVE_MIN`, opencode v2.2.7
 * packages/core/src/session/compaction.ts): a start nearer the window than
 * this leaves the summary request too little, and one under it compacts a
 * context that holds little more than the summary itself.
 */
const SUMMARY_ROOM_TOKENS = 16_000;

/**
 * The window OpenCode measures a model's context against, from models.dev,
 * whose provider ids OpenCode's are: the input limit where one is stated below
 * the context window, as both majors read it. Only a provider Ordewell's own
 * table carries is known; any other comes back unknown.
 */
export function openCodeModelWindow(model: string): number | undefined {
  const split = splitModelId(model);
  if (!split) return undefined;
  const ours = (Object.keys(MODELS_DEV_PROVIDERS) as AiProvider[]).find((id) => MODELS_DEV_PROVIDERS[id] === split.providerID);
  const details = ours ? modelDetails().lookup(ours, split.modelID) : undefined;
  if (details?.contextWindow === undefined) return undefined;
  return Math.min(details.contextWindow, details.inputLimit ?? details.contextWindow);
}

/**
 * Where a task's OpenCode compacts, as `compaction.reserved` in the config
 * Ordewell injects, or nothing. `auto` and `off` leave OpenCode's own start,
 * already near the window: 85% of it on 2.x (a 15% buffer, 16k at least) and
 * the input limit less 20k on 1.x (opencode v1.18.9 and v2.2.7). OpenCode has no option naming a start, only
 * the room kept below the window, so a number N becomes `reserved = window - N`,
 * which needs the model's window. 1.x reads `reserved` natively; 2.x reads it as
 * its `buffer` in tokens. 1.x applies it only to a model with an input limit;
 * for any other it keeps its own start, the window less the reply. The version is learned only once the server answers,
 * after the config is written, so the one key serves both.
 */
export function openCodeCompaction(
  model: string | undefined,
  at: TaskCompactAt,
  windowOf: (model: string) => number | undefined = openCodeModelWindow,
  log: (line: string) => void = (line) => console.warn(line),
): { reserved: number; start: number } | undefined {
  if (typeof at !== 'number') return undefined;
  const window = model ? windowOf(model) : undefined;
  if (window === undefined || window <= 2 * SUMMARY_ROOM_TOKENS) {
    log(`[opencode] taskCompactAt ${at} is not applied: the window of ${model ?? 'the default model'} is not known, so OpenCode compacts at its own start.`);
    return undefined;
  }
  const start = clampTaskCompactAt(at, { min: SUMMARY_ROOM_TOKENS, max: window - SUMMARY_ROOM_TOKENS }, 'OpenCode', log);
  return { reserved: window - start, start };
}
