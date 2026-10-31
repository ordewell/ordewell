import { describe, it, expect } from 'vitest';
import { PLANNER_TOOLS, READ_ONLY_TASK_TOOLS, TASK_TOOLS, type McpTool } from '../tools';

/**
 * What each role's tool list costs before its first word: a runner is sent
 * every tool's description and schema, on every attempt, and a planner on
 * every turn it takes. Each ceiling sits just above today's size, so a tool
 * that grows (or a new one) fails here and has to be argued for: raise the
 * ceiling in the same change, and say what the text buys.
 */

/** The tool list as a runner is sent it, in characters. */
function serialisedSize(tools: readonly McpTool<never>[]): number {
  return JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
}

describe('the size of a role\'s tool set', () => {
  it.each([
    ['PLANNER_TOOLS', PLANNER_TOOLS, 23_000],
    ['TASK_TOOLS', TASK_TOOLS, 8_200],
    ['READ_ONLY_TASK_TOOLS', READ_ONLY_TASK_TOOLS, 10_700],
  ])('keeps %s under its ceiling', (_name, tools, ceiling) => {
    expect(serialisedSize(tools)).toBeLessThanOrEqual(ceiling);
  });
});
