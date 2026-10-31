import { describe, it, expect } from 'vitest';
import { PLANNER_TOOLS, READ_ONLY_TASK_TOOLS, TASK_TOOLS, toolListing, type McpTool } from '../tools';

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
    ['PLANNER_TOOLS', PLANNER_TOOLS, 23_400],
    ['TASK_TOOLS', TASK_TOOLS, 8_200],
    ['READ_ONLY_TASK_TOOLS', READ_ONLY_TASK_TOOLS, 10_700],
  ])('keeps %s under its ceiling, counting annotations', (_name, tools, ceiling) => {
    expect(sentSize(tools)).toBeLessThanOrEqual(ceiling);
  });
});
