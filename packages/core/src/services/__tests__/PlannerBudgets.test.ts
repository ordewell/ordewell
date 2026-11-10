import { describe, it, expect } from 'vitest';
import { TurnBudgets, contextLine, taskReadsLine, webReadsLine, withTurnBudgets } from '../PlannerBudgets';

describe('budget lines', () => {
  it('shows the context against its window', () => {
    expect(contextLine({ usedTokens: 61_000, windowTokens: 1_000_000 })).toBe('Context: 61k of 1,000k tokens used (6%).');
  });

  it('shows a context under one percent as such, and a small one exactly', () => {
    expect(contextLine({ usedTokens: 900, windowTokens: 1_000_000 })).toBe('Context: 900 of 1,000k tokens used (<1%).');
  });

  it('says the window is unknown rather than guessing one', () => {
    expect(contextLine({ usedTokens: 61_000 })).toBe('Context: 61k tokens used; the window size is not known.');
  });

  it('leaves the context out before any call was measured', () => {
    expect(contextLine(undefined)).toBeUndefined();
  });

  it('counts a user turn\'s task reads down to the instruction to land, and names the hard stop', () => {
    expect(taskReadsLine({ left: 3, hardStop: 6 })).toBe('Task reads left for this message: 3 (hard stop after 6).');
  });

  it('names a wake-up turn\'s one budget without a separate stop', () => {
    expect(taskReadsLine({ left: 4 })).toBe('Task reads left for this wake-up: 4.');
  });

  it('never shows a negative count', () => {
    expect(taskReadsLine({ left: -2, hardStop: 6 })).toContain(': 0 (');
    expect(webReadsLine(-1)).toBe('Web reads left this turn: 0.');
  });

  it('leaves out a read count that is not known', () => {
    expect(taskReadsLine(undefined)).toBeUndefined();
    expect(webReadsLine(undefined)).toBeUndefined();
  });
});

describe('TurnBudgets', () => {
  it('renders each known line under one header, in the order the providers were added', () => {
    const budgets = new TurnBudgets([() => 'A.', () => 'B.']);
    budgets.add(() => 'C.');
    expect(budgets.render()).toBe('CONTEXT AND BUDGETS (this turn):\n- A.\n- B.\n- C.');
  });

  it('omits the line of a provider with nothing to say', () => {
    const budgets = new TurnBudgets([() => undefined, () => 'B.']);
    expect(budgets.render()).toBe('CONTEXT AND BUDGETS (this turn):\n- B.');
  });

  it('renders nothing when no budget is known, and leaves the message as it was', () => {
    const budgets = new TurnBudgets([() => undefined]);
    expect(budgets.render()).toBeUndefined();
    expect(budgets.appendTo('hello')).toBe('hello');
  });

  it('reads its providers afresh on every render', () => {
    let left = 3;
    const budgets = new TurnBudgets([() => webReadsLine(left)]);
    expect(budgets.render()).toContain('3.');
    left = 2;
    expect(budgets.render()).toContain('2.');
  });

  it('appends the block after the message', () => {
    expect(new TurnBudgets([() => 'A.']).appendTo('hello')).toBe('hello\n\nCONTEXT AND BUDGETS (this turn):\n- A.');
  });

  it('sends the message untouched when a service has no budgets', () => {
    expect(withTurnBudgets(undefined, 'hello')).toBe('hello');
  });
});
