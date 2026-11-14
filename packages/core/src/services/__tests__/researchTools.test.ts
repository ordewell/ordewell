import { describe, it, expect } from 'vitest';
import { RESEARCH_TOOLS, plannerToolDefinitions, subagentToolDefinitions, subagentToolSpecs, SPAWN_RESEARCH_AGENT } from '../researchTools';
import { CONFINED_RESEARCH_TOOLS } from '../ResearchSubagents';
import type { ToolDefinition } from '../model';

const named = (tools: ToolDefinition[], name: string): ToolDefinition => tools.find((t) => t.name === name)!;
const names = (tools: ToolDefinition[]): string[] => tools.map((t) => t.name);

describe('researchTools', () => {
  it('declares the research tools and the spawn tool, the one list every dialect is sent', () => {
    expect(names(plannerToolDefinitions()).sort()).toEqual([...RESEARCH_TOOLS.map((t) => t.name), SPAWN_RESEARCH_AGENT].sort());
  });

  it('projects each tool as a JSON-schema object', () => {
    expect(named(plannerToolDefinitions(), 'read_file').parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(named(plannerToolDefinitions(), 'read_files').parameters).toMatchObject({
      properties: { paths: { type: 'array', items: { type: 'string' } } },
    });
  });

  it('spawn tool takes a single self-contained prompt (opencode-style, one agent per call)', () => {
    expect(named(plannerToolDefinitions(), SPAWN_RESEARCH_AGENT).parameters).toMatchObject({
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    });
  });

  it('subagent toolset keeps the read-only and web tools but never recurses', () => {
    const specs = subagentToolSpecs().map((t) => t.name);
    expect(specs).toEqual(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir', 'bash', 'fetch', 'web_search']);
    expect(names(subagentToolDefinitions())).toEqual(specs);
  });

  it('narrows a confined agent to its own tools (ADR-0066)', () => {
    expect(names(subagentToolDefinitions(CONFINED_RESEARCH_TOOLS)).sort()).toEqual([...CONFINED_RESEARCH_TOOLS].sort());
    expect(subagentToolDefinitions().length).toBeGreaterThan(CONFINED_RESEARCH_TOOLS.size);
  });

  it('withholds the spawn tool from a provider that cannot run subagents, keeping its reads', () => {
    expect(names(plannerToolDefinitions())).toContain(SPAWN_RESEARCH_AGENT);
    expect(names(plannerToolDefinitions(false, false, false))).not.toContain(SPAWN_RESEARCH_AGENT);
    expect(names(plannerToolDefinitions(true, false, false))).not.toContain(SPAWN_RESEARCH_AGENT);
    expect(names(plannerToolDefinitions(true, false, false))).toEqual(expect.arrayContaining(['read_file', 'task_query', 'run_plan']));
  });

  it('adds `post` after a planner\'s flat list and moves nothing in it, so a flat conversation sends the same bytes (ADR-0057 R11)', () => {
    const flat = JSON.stringify(plannerToolDefinitions(true));
    const board = plannerToolDefinitions(true, true);

    expect(board.at(-1)?.name).toBe('post');
    expect(JSON.stringify(board.slice(0, -1))).toBe(flat);
    expect(names(plannerToolDefinitions())).not.toContain('post');
  });

  it('declares `post`\'s entry types and required fields', () => {
    const types = ['finding', 'claim', 'attempt', 'artifact', 'contract', 'assume', 'scope_change', 'decision', 'pin'];
    const post = plannerToolDefinitions(true, true).at(-1)!.parameters as { properties: { type: { enum: string[] }; files: { items: unknown } }; required: string[] };

    expect([...post.properties.type.enum].sort()).toEqual([...types].sort());
    expect(post.required).toEqual(['type', 'title']);
    expect(post.properties.files.items).toMatchObject({ type: 'string' });
  });
});

describe('planner task read tool projections', () => {
  it('offers the attempt, kind and diff parameters', () => {
    const tools = plannerToolDefinitions(true);
    for (const name of ['task_query', 'task_output', 'task_diff']) {
      expect(named(tools, name).parameters).toMatchObject({ type: 'object', properties: expect.any(Object) });
    }
    expect(named(tools, 'task_output').parameters).toMatchObject({ properties: { attempt: { type: 'integer', minimum: 1 }, kinds: { items: { enum: expect.arrayContaining(['tool_call', 'tool_result', 'text', 'error', 'approval_requested', 'usage']) } } } });
  });
});
