import type { ContextFill } from '../models/Usage';

/**
 * One line of the planner's budget block, or nothing when its number is not
 * known yet. A provider reads its source when the turn's input is built, so a
 * number is as fresh as the turn it rides on.
 */
export type BudgetProvider = () => string | undefined;

const HEADER = 'CONTEXT AND BUDGETS (this turn):';

/**
 * What the planner can see of its own limits (#108): a model cannot manage a
 * context or a read budget it cannot see. Every planner turn's input gets
 * {@link appendTo}'s block — in the turn's content and never the system
 * prompt, which stays the same from turn to turn and so stays cacheable. The
 * set of budgets is a list of providers, so a new limit joins by adding one
 * here and touches no planner backend.
 */
export class TurnBudgets {
  private readonly providers: BudgetProvider[];

  constructor(providers: readonly BudgetProvider[] = []) {
    this.providers = [...providers];
  }

  add(provider: BudgetProvider): void {
    this.providers.push(provider);
  }

  /** The block, or undefined when no budget has a number to show. */
  render(): string | undefined {
    const lines = this.providers.map((provider) => provider()).filter((line): line is string => line !== undefined);
    return lines.length > 0 ? [HEADER, ...lines.map((line) => `- ${line}`)].join('\n') : undefined;
  }

  appendTo(message: string): string {
    const block = this.render();
    return block ? `${message}\n\n${block}` : message;
  }
}

/** Appends `budgets`' block to a turn's input; a service built without budgets sends the input as it is. */
export function withTurnBudgets(budgets: TurnBudgets | undefined, message: string): string {
  return budgets ? budgets.appendTo(message) : message;
}

/** `61k`, `1,000k`, and the exact count below a thousand. */
function tokens(n: number): string {
  return n < 1000 ? String(n) : `${Math.round(n / 1000).toLocaleString('en-US')}k`;
}

/** The context as its last call left it; the window part only where it is known, never guessed. */
export function contextLine(fill: ContextFill | undefined): string | undefined {
  if (!fill) return undefined;
  if (!fill.windowTokens) return `Context: ${tokens(fill.usedTokens)} tokens used; the window size is not known.`;
  const share = fill.usedTokens / fill.windowTokens * 100;
  return `Context: ${tokens(fill.usedTokens)} of ${tokens(fill.windowTokens)} tokens used (${share < 1 ? '<1' : Math.round(share)}%).`;
}

/**
 * Task reads left before the turn is told to land, and the count after which
 * a read is refused. A wake-up turn has one budget and no separate stop, so it
 * names `left` alone.
 */
export function taskReadsLine(reads: { left: number; hardStop?: number } | undefined): string | undefined {
  if (!reads) return undefined;
  const left = Math.max(0, reads.left);
  const stop = reads.hardStop !== undefined ? ` (hard stop after ${reads.hardStop})` : '';
  return `Task reads left for ${reads.hardStop !== undefined ? 'this message' : 'this wake-up'}: ${left}${stop}.`;
}

export function webReadsLine(left: number | undefined): string | undefined {
  return left === undefined ? undefined : `Web reads left this turn: ${Math.max(0, left)}.`;
}
