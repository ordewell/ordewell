import { describe, it, expect } from 'vitest';
import { summarizeToolCall } from '../researchStepSummary';
import { mapAgentTool, normalizeAgentArgs } from '../harness/agentTools';

describe('summarizeToolCall', () => {
  it('summarizes a file-path tool call by basename', () => {
    expect(summarizeToolCall('read_file', JSON.stringify({ filePath: 'src/services/auth.ts' }))).toBe('read_file auth.ts');
    expect(summarizeToolCall('read_file', JSON.stringify({ path: 'src/a.ts' }))).toBe('read_file a.ts');
  });

  it('summarizes a pattern-based tool call', () => {
    expect(summarizeToolCall('grep', JSON.stringify({ pattern: 'TODO' }))).toBe('grep TODO');
  });

  it('summarizes a glob by its pattern, not by the directory it searched', () => {
    // Agents pass a search root alongside the pattern; reading the root first
    // reported every call as the same directory name.
    expect(summarizeToolCall('glob', JSON.stringify({ pattern: '**/*.test.ts', path: '/repo/src' })))
      .toBe('glob **/*.test.ts');
  });

  it('summarizes a bash command, truncated', () => {
    const cmd = 'x'.repeat(80);
    expect(summarizeToolCall('bash', JSON.stringify({ command: cmd }))).toBe(`bash: ${cmd.slice(0, 40)}`);
  });

  it('summarizes a spawn_research_agent call from its prompt', () => {
    const summary = summarizeToolCall('spawn_research_agent', JSON.stringify({ prompt: 'Explore the auth module' }));
    expect(summary).toBe('spawn: "Explore the auth module"');
  });

  it('truncates a long spawn prompt', () => {
    const prompt = 'a'.repeat(100);
    const summary = summarizeToolCall('spawn_research_agent', JSON.stringify({ prompt }));
    expect(summary).toBe(`spawn: "${'a'.repeat(60)}…"`);
  });

  it('falls back to the bare tool name when args are unrecognized or malformed', () => {
    expect(summarizeToolCall('list_dir', JSON.stringify({ depth: 2 }))).toBe('list_dir');
    expect(summarizeToolCall('glob', 'not json')).toBe('glob');
    expect(summarizeToolCall('spawn_research_agent', 'not json')).toBe('spawn_research_agent');
  });
});

describe('harness planner tool naming (ADR-0009)', () => {
  it('maps an agent tool with a Ordewell equivalent onto that member, keeping the agent name', () => {
    expect(mapAgentTool('Read')).toEqual({ tool: 'read_file', toolLabel: 'Read' });
    expect(mapAgentTool('Grep')).toEqual({ tool: 'grep', toolLabel: 'Grep' });
    expect(mapAgentTool('WebFetch')).toEqual({ tool: 'fetch', toolLabel: 'WebFetch' });
    // Codex calls its sandboxed command tool `shell`; it is a bash by any name.
    expect(mapAgentTool('shell')).toEqual({ tool: 'bash', toolLabel: 'shell' });
  });

  it('routes anything with no equivalent to agent_tool rather than mislabelling it', () => {
    expect(mapAgentTool('TodoWrite')).toEqual({ tool: 'agent_tool', toolLabel: 'TodoWrite' });
    expect(mapAgentTool('Edit')).toEqual({ tool: 'agent_tool', toolLabel: 'Edit' });
    expect(mapAgentTool('some_future_tool')).toEqual({ tool: 'agent_tool', toolLabel: 'some_future_tool' });
  });

  it('renders an agent tool under its own name, never as the catch-all member', () => {
    expect(summarizeToolCall('agent_tool', JSON.stringify({ path: 'src/a.ts' }), 'Edit')).toBe('Edit src/a.ts');
    expect(summarizeToolCall('agent_tool', JSON.stringify({}), 'TodoWrite')).toBe('TodoWrite');
    expect(summarizeToolCall('agent_tool', 'not json', 'Task')).toBe('Task');
  });

  it('prefers the agent name over the member name in mapped summaries', () => {
    expect(summarizeToolCall('read_file', JSON.stringify({ file_path: 'src/a.ts' }), 'Read')).toBe('Read a.ts');
  });

  it('normalizes agent arg shapes into the ones the summary already reads', () => {
    expect(normalizeAgentArgs('read_file', { file_path: '/repo/a.ts' }).path).toBe('/repo/a.ts');
    // Codex hands a command over as argv; the summary wants one string.
    expect(normalizeAgentArgs('bash', { command: ['rg', '-n', 'foo'] }).command).toBe('rg -n foo');
  });
});
