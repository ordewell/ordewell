import { type DecisionRecordEntry } from '@ordewell/core';
import { positionals } from '../utils';
import { type ApiClient } from '../apiClient';
import { RECORD_EMPTY, recordView } from '../decisionRecordView';
import { sanitize } from '../tui/ansi';
import { adopted } from './conversation';
import { fail } from './shared';

const USAGE = 'Usage: ordewell decisions [all] [--session-id <id>] [--workspace /path]';

const oneLine = (text: string) => sanitize(text).replace(/\s+/g, ' ').trim();

/**
 * The planner's decision record (ADR-0067), as the TUI's `/decisions [all]`
 * shows it: what stands, grouped by kind, each entry with its id and why.
 * `all` adds what a later entry superseded. Plain lines, so a pipe reads them.
 */
export async function handleDecisions(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const [which, ...extra] = positionals(subArgs);
  if (extra.length > 0 || (which !== undefined && which.toLowerCase() !== 'all')) fail(USAGE);
  const all = which !== undefined;

  const { plan } = await adopted(subArgs, injectedApi);
  const record = (plan as { decisionRecord?: DecisionRecordEntry[] } | null)?.decisionRecord ?? [];
  if (record.length === 0) {
    console.log(RECORD_EMPTY);
    return;
  }
  const view = recordView(record, all);
  console.log(`${view.standing} standing${view.hidden > 0 ? (all ? ` · ${view.hidden} superseded (shown)` : ` · ${view.hidden} superseded (\`ordewell decisions all\` shows them)`) : ''}`);
  for (const { heading, entries } of view.sections) {
    console.log(`\n${heading}`);
    for (const entry of entries) {
      console.log(`  ${entry.id} ${oneLine(entry.text)}${entry.supersededBy ? ` (superseded by ${entry.supersededBy})` : ''}`);
      if (entry.why) console.log(`      why: ${oneLine(entry.why)}`);
    }
  }
}
