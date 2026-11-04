import { describe, it, expect, vi } from 'vitest';
import { CONNECTORS } from '../harness/connectors';
import type { AgentEvent, AgentStartOptions } from '../harness/AgentAdapter';
import { mcpClientConfig } from '../mcp';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { FAKE_RUNNERS } from './fakeRunners';

/**
 * A task tool added to the server reaches every runner with no adapter edit:
 * #37's runner-facing tools join `TASK_TOOLS` this way (ADR-0022).
 */

vi.mock('../mcp/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/tools')>();
  const boardPost: (typeof actual.TASK_TOOLS)[number] = {
    name: 'board_post',
    description: 'Post to the board.',
    inputSchema: { type: 'object' },
    call: async () => ({ text: 'Posted.' }),
  };
  return { ...actual, TASK_TOOLS: [...actual.TASK_TOOLS, boardPost] };
});

const RUNNER_NAME: Record<string, string> = {
  'claude-code': 'mcp__ordewell__board_post',
  codex: 'mcp__ordewell__board_post',
  opencode: 'ordewell_board_post',
  'copilot-cli': 'ordewell-board_post',
  'qwen-code': 'mcp__ordewell__board_post',
  cline: 'ordewell__board_post',
  'gemini-cli': 'mcp_ordewell_board_post',
};

const runners = Object.keys(CONNECTORS).filter((runner) => CONNECTORS[runner].ordewellTools);
const manifests = new RunnerRegistry();

describe.each(runners)('a new task tool on %s', (runner) => {
  it('is in the binding, given to the task unasked, and allowed when asked for', async () => {
    const fake = FAKE_RUNNERS[runner]({ attach: 'connected' });
    const adapter = CONNECTORS[runner].create(fake.deps);
    const manifest = manifests.get(runner)!.manifest;
    const mode = manifest.modes![0].id;
    const start: AgentStartOptions = {
      kind: 'task', cwd: '/repo', mode, flags: resolveTaskRunnerFlags(manifest, { mode }),
      mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' }),
    };
    await adapter.start(fake.withServer?.(start) ?? start);
    void adapter.send('go', (_event: AgentEvent) => {});
    await fake.turnOpen();

    expect(CONNECTORS[runner].ordewellTools!.toolNames('task')).toContain(RUNNER_NAME[runner]);
    expect(await fake.preAllows(RUNNER_NAME[runner])).toBe(true);
    expect(await fake.askOrdewellTool('board_post')).toBe('allow');
    adapter.dispose();
  });
});

it('is named, with the others, where Codex is told to look for the task tools', async () => {
  const fake = FAKE_RUNNERS.codex({ attach: 'connected' });
  const adapter = CONNECTORS.codex.create(fake.deps);
  const manifest = manifests.get('codex')!.manifest;
  await adapter.start({
    kind: 'task', cwd: '/repo', mode: 'agent', flags: resolveTaskRunnerFlags(manifest, { mode: 'agent' }),
    mcp: mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok' }),
  });

  expect(fake.instructions()).toContain('five tools from the `ordewell` MCP server: `task_complete`, `checkpoint`, `read`, `apply_patch` and `board_post`.');
  expect(fake.instructions()).toContain('`mcp__ordewell__task_complete`, `mcp__ordewell__checkpoint`, `mcp__ordewell__read`, `mcp__ordewell__apply_patch` and `mcp__ordewell__board_post`');
  adapter.dispose();
});
