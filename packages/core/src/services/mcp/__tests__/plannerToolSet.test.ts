import { describe, it, expect } from 'vitest';
import { OrdewellMcpServer } from '../OrdewellMcpServer';
import { PLANNER_TOOLS, SUBPLANNER_TOOLS, plannerToolSet, toolListing } from '../tools';
import { ordewellToolNames } from '../../harness/ordewellBinding';

/** What a planner's token lists (ADR-0055 D5, D21, ADR-0056 M6). */

const listOf = (delegates: boolean, subplanner: boolean) => toolListing(plannerToolSet({ delegates, subplanner }));
const submitType = (tools: ReturnType<typeof toolListing>) => {
  const submit = tools.find((t) => t.name === 'submit_plan') as unknown as { inputSchema: { properties: { tasks: { items: { properties: { type: { enum: string[] } } } } } } };
  return submit.inputSchema.properties.tasks.items.properties.type.enum;
};

describe('the planner tool set', () => {
  it('is the flat list itself where nothing delegates, so its tools do not move by a byte', () => {
    expect(plannerToolSet()).toBe(PLANNER_TOOLS);
    expect(plannerToolSet({ delegates: false, subplanner: false })).toBe(PLANNER_TOOLS);
    expect(JSON.stringify(toolListing(plannerToolSet()))).toBe(JSON.stringify(toolListing(PLANNER_TOOLS)));
    expect(submitType(toolListing(PLANNER_TOOLS))).toEqual(['ai', 'user', 'script']);
  });

  it('takes a delegated task in submit_plan and a raise in answer_checkpoint only where one may be written, adds `read` and `post`, and changes no other tool', () => {
    const on = listOf(true, false);
    expect(submitType(on)).toEqual(['ai', 'user', 'script', 'delegated']);
    const flat = toolListing(PLANNER_TOOLS);
    expect(on.map((t) => t.name)).toEqual([...flat.map((t) => t.name), 'read', 'post']);
    const others = (tools: typeof flat) => tools.filter((t) => t.name !== 'submit_plan' && t.name !== 'answer_checkpoint' && t.name !== 'read' && t.name !== 'post');
    expect(others(on)).toEqual(others(flat));
    const raise = (tools: typeof flat) => JSON.stringify(tools.find((t) => t.name === 'answer_checkpoint')).includes('raiseTokens');
    expect([raise(on), raise(flat)]).toEqual([true, false]);
  });

  it('gives a subplanner its board, task_complete and checkpoint, and no plan_complete or ask_parent', () => {
    const names = listOf(false, true).map((t) => t.name);
    expect(names).toEqual([...PLANNER_TOOLS.map((t) => t.name), 'read', 'post', 'task_complete', 'checkpoint']);
    expect(names).not.toContain('plan_complete');
    expect(names).not.toContain('ask_parent');
  });

  it('pre-allows them with the rest, under a subplanner\'s token only', () => {
    expect(ordewellToolNames('planner')).not.toContain('task_complete');
    expect(ordewellToolNames('planner', [], SUBPLANNER_TOOLS.map((t) => t.name))).toContain('task_complete');
  });
});

describe('a subplanner\'s token', () => {
  it('names the tools past a planner\'s, and a flat planner\'s names none', async () => {
    const server = new OrdewellMcpServer();
    const flat = await server.issuePlannerToken({ sessionId: 's' });
    const subplanner = await server.issuePlannerToken({ sessionId: 's', subplanner: true });
    expect(flat.extraTools).toBeUndefined();
    expect(subplanner.extraTools).toEqual(['read', 'post', 'task_complete', 'checkpoint']);
    await server.dispose();
  });
});

describe('a token serving the research agent (ADR-0066)', () => {
  it('names spawn_research_agent past a planner\'s tools, so a client pre-allows it, and no other tool', async () => {
    const server = new OrdewellMcpServer();
    const research = await server.issuePlannerToken({ sessionId: 's', research: true });
    expect(research.extraTools).toEqual(['spawn_research_agent']);
    expect(ordewellToolNames('planner', [], research.extraTools)).toEqual([...PLANNER_TOOLS.map((t) => t.name), 'spawn_research_agent']);
    await server.dispose();
  });
});
