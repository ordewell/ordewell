import { describe, it, expect } from 'vitest';
import { PLANNER_TOOLS, READ_ONLY_TASK_TOOLS, TASK_TOOLS, plannerToolSet, taskToolSet, toolListing, type McpTool } from '../tools';

/**
 * What each role's tool list costs before its first word: a runner is sent
 * every tool's description, schema and annotations, on every attempt, and a
 * planner on every turn it takes. `toolListing` is what `tools/list` answers
 * with, so this counts what is sent. Each ceiling sits just above today's size,
 * so a tool that grows (or a new one) fails here and has to be argued for:
 * raise the ceiling in the same change, and say what the text buys.
 */
function sentSize(tools: readonly McpTool<never>[]): number {
  return JSON.stringify(toolListing(tools)).length;
}

describe('the tool list a runner is actually sent', () => {
  it.each([
    // `record` is in every planner's list (ADR-0067): the decision record a checkpoint seeds the next context with.
    ['PLANNER_TOOLS', PLANNER_TOOLS, 24_300],
    ['TASK_TOOLS', TASK_TOOLS, 8_200],
    ['READ_ONLY_TASK_TOOLS', READ_ONLY_TASK_TOOLS, 10_700],
    // A board's cost to a runner in a subtree (ADR-0057 R8, R11): `post` and nothing else, `read` taking "board" as it stands.
    ['a task on a board', taskToolSet({ board: true }), 9_500],
    ['a read-only task on a board', taskToolSet({ readOnly: true, board: true }), 12_000],
    // Delegation's cost, past the flat list (ADR-0057 R11): what `submit_plan` adds to take a delegated task, `read`, `post`, and a raise on `answer_checkpoint` (ADR-0056 M5).
    ['a delegating planner', plannerToolSet({ delegates: true }), 27_800],
    // A subplanner's `task_complete` and `checkpoint`, with `promote` and `open`, and that its question parks it (ADR-0056 M8), and its board's `read` and `post`.
    ['a subplanner', plannerToolSet({ subplanner: true }), 32_700],
    ['a subplanner that may delegate', plannerToolSet({ delegates: true, subplanner: true }), 34_100],
  ])('keeps %s under its ceiling, counting annotations', (_name, tools, ceiling) => {
    expect(sentSize(tools)).toBeLessThanOrEqual(ceiling);
  });
});
