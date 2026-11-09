import type { ContextFill } from '../models/Usage';

/**
 * One line of the planner's budget block, or nothing when its number is not
 * known yet. A provider reads its source when the turn's input is built, so a
 * number is as fresh as the turn it rides on.
 */
export type BudgetProvider = () => string | undefined;

const HEADER = 'CONTEXT AND BUDGETS (this turn):';

/** The experiment's switch: on only when it is exactly `1`. The planning bench sets it. */
export const OWN_READS_METER_ENV = 'ORDEWELL_PLANNER_READ_METER';

/** Characters per token for the meter's estimate: coarse on purpose, and the line says so. */
const CHARS_PER_TOKEN = 4;

/**
 * What the planner's own workspace reads put into its context, in characters.
 * Experiment: a planner that reads widely itself spends the context it keeps
 * for coordinating, and this lets it see that. A backend notes each read it
 * can measure; `endTurn` rolls the count, because the block rides on a turn's
 * input before that turn's reads happen, so it can only report the last turn.
 */
class OwnReadsMeter {
  private turnChars = 0;
  private totalChars = 0;

  note(chars: number): void {
    this.turnChars += chars;
    this.totalChars += chars;
  }

  line(): string {
    const tokensOf = (chars: number) => tokens(Math.ceil(chars / CHARS_PER_TOKEN));
    return `Your own reads: about ${tokensOf(this.turnChars)} tokens last turn, ${tokensOf(this.totalChars)} in this conversation (approximate, from characters).`;
  }

  endTurn(): void {
    this.turnChars = 0;
  }
}

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
  private ownReads: OwnReadsMeter | undefined;

  constructor(providers: readonly BudgetProvider[] = []) {
    this.providers = [...providers];
  }

  add(provider: BudgetProvider): void {
    this.providers.push(provider);
  }

  /**
   * Experiment: turns the own-reads meter on when `env` says exactly `1`; any
   * other value leaves it off and the block as it always was.
   */
  measureOwnReads(env: NodeJS.ProcessEnv = process.env): void {
    if (env[OWN_READS_METER_ENV] === '1') this.ownReads ??= new OwnReadsMeter();
  }

  /** A planner backend calls this for each of the planner's own workspace reads it can measure. */
  noteOwnRead(chars: number): void {
    this.ownReads?.note(chars);
  }

  /**
   * The block, or undefined when no budget has a number to show.
   * `reportsOwnReads` is whether this turn's backend measures the planner's
   * own reads; one that cannot gets no line rather than a false zero.
   */
  render(reportsOwnReads = false): string | undefined {
    const lines = this.providers.map((provider) => provider()).filter((line): line is string => line !== undefined);
    if (reportsOwnReads && this.ownReads) lines.push(this.ownReads.line());
    return lines.length > 0 ? [HEADER, ...lines.map((line) => `- ${line}`)].join('\n') : undefined;
  }

  appendTo(message: string, reportsOwnReads = false): string {
    const block = this.render(reportsOwnReads);
    this.ownReads?.endTurn();
    return block ? `${message}\n\n${block}` : message;
  }
}

/** Appends `budgets`' block to a turn's input; a service built without budgets sends the input as it is. */
export function withTurnBudgets(budgets: TurnBudgets | undefined, message: string, reportsOwnReads = false): string {
  return budgets ? budgets.appendTo(message, reportsOwnReads) : message;
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
