import { positionals } from '../utils';
import { type ApiClient } from '../apiClient';
import { HANDOFF_USAGE, landRun } from './merge';
import { askYesNo } from './shared';

/** The old name of `ordewell merge` (the TUI's `/handoff` was renamed the same way): the same command, with a pointer to the new one. */
export async function handleHandoff(
  subArgs: string[],
  injectedApi?: ApiClient,
  confirm: (question: string) => Promise<boolean> = askYesNo,
): Promise<void> {
  console.error('`ordewell handoff` is deprecated: use `ordewell merge` (`ordewell merge review|discard|cleanup` for the other actions).');
  await landRun(positionals(subArgs)[0]?.toLowerCase(), 'handoff', HANDOFF_USAGE, subArgs, injectedApi, confirm);
}
