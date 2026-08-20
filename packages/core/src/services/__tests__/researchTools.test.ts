import { describe, it, expect } from 'vitest';
import { SchemaType } from '@google/generative-ai';
import { RESEARCH_TOOLS, toOpenAiTools, toGeminiToolDeclarations, subagentToolSpecs, SPAWN_RESEARCH_AGENT } from '../researchTools';

describe('researchTools', () => {
  it('exposes the same tool set to both providers', () => {
    const canonical = [...RESEARCH_TOOLS.map((t) => t.name), SPAWN_RESEARCH_AGENT].sort();
    const openai = toOpenAiTools().map((t) => t.function.name).sort();
    const gemini = toGeminiToolDeclarations().map((t) => t.name).sort();
    expect(openai).toEqual(canonical);
    expect(gemini).toEqual(canonical);
  });

  it('projects OpenAI tools as JSON-schema functions', () => {
    const readFile = toOpenAiTools().find((t) => t.function.name === 'read_file')!;
    expect(readFile.type).toBe('function');
    expect(readFile.function.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
  });

  it('spawn tool takes a single self-contained prompt (opencode-style, one agent per call)', () => {
    const spawn = toOpenAiTools().find((t) => t.function.name === SPAWN_RESEARCH_AGENT)!;
    expect(spawn.function.parameters).toMatchObject({
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    });
  });

  it('subagent toolset drops the network tools (they can block on user confirmation) and never recurses', () => {
    const names = subagentToolSpecs().map((t) => t.name);
    expect(names).toEqual(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir', 'bash']);
    expect(names).not.toContain('fetch');
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('spawn_research_agent');
  });

  it('projects Gemini declarations using SchemaType enums', () => {
    const readFiles = toGeminiToolDeclarations().find((t) => t.name === 'read_files')!;
    const params = readFiles.parameters!;
    expect(params.type).toBe(SchemaType.OBJECT);
    expect(params.properties!.paths.type).toBe(SchemaType.ARRAY);
    expect(params.properties!.paths.items!.type).toBe(SchemaType.STRING);
  });
});
