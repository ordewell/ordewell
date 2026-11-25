import { orderByChoice, runnerChoiceRefusal, runnerEntryChoice, runnerEntryReadiness, signInAction, signInOfVerdict, type RunnerChoice } from '@ordewell/core';
import type { PickerItem, RunnerView } from './state';

/**
 * A runner row as the terminal's pickers show it, from core's one
 * readiness-to-choice rule (ADR-0052): the short status with the usual command
 * that fixes it, and the refusal a new pick of a blocked runner gets.
 */
export interface RunnerRowChoice {
  choice: RunnerChoice;
  /** `Signed out · /login cursor-agent`; absent on a ready or unusable row. */
  status?: string;
  /** What the row adds to a picker item: a blocked row is flagged, and refused unless `kept`. */
  item: Pick<PickerItem, 'warn' | 'disabled' | 'refusal'>;
}

/** The terminal command a row's recovery is: `/login` (a sign-in or the agent's setup), `/key-set` or `/refresh`. */
function recoveryCommand(row: RunnerView, choice: RunnerChoice): string | undefined {
  switch (choice.recovery?.kind) {
    case 'sign-in': {
      const action = signInAction(signInOfVerdict(row.id, row.name, row.auth));
      return action === 'login' ? `/login ${row.id}` : action === 'key' ? '/key-set' : undefined;
    }
    // The agent's own setup is its way to a key Ordewell reads, and `/login` runs it.
    case 'set-up':
      return `/login ${row.id}`;
    case 'add-key':
      return '/key-set';
    case 'refresh-models':
    case 'retry':
      return '/refresh';
    default:
      return undefined;
  }
}

/**
 * `kept` says the row is the user's earlier choice (the planner in effect, a
 * task's own runner, a runner already on): choosing it again makes no new
 * pick, so a blocked row stays choosable there and is only flagged.
 */
export function runnerRowChoice(row: RunnerView, kept: boolean): RunnerRowChoice {
  const choice = runnerEntryChoice(row);
  const command = choice.text ? recoveryCommand(row, choice) : undefined;
  const status = choice.text && (command ? `${choice.text} · ${command}` : choice.text);
  if (choice.group !== 'blocked') return { choice, ...(status ? { status } : {}), item: {} };
  const refusal = runnerChoiceRefusal(row.name, runnerEntryReadiness(row)) ?? undefined;
  return { choice, ...(status ? { status } : {}), item: kept ? { warn: true } : { warn: true, disabled: true, ...(refusal ? { refusal } : {}) } };
}

/** The refusal a new pick of `row` gets, or null where it may be picked. */
export function runnerPickRefusal(row: RunnerView): string | null {
  return runnerRowChoice(row, false).item.refusal ?? null;
}

/** The runners in picker order: the choosable first, then the blocked, then the unusable, each as listed. */
export function runnersInChoiceOrder(rows: readonly RunnerView[]): RunnerView[] {
  return orderByChoice(rows, runnerEntryChoice);
}
