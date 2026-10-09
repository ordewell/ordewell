import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrdewellMcpServer } from '../mcp';
import { VerdictEngine } from '../VerdictEngine';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { createTask } from '../../models/Task';
import type { Verdict } from '../../models/Task';
import { fakeSpawn, fixture } from './harnessTestKit';

describe('VerdictEngine over recorded structured output', () => {
  it('ignores completion and checkpoint text and fails a clean process exit without a call', async () => {
    const spawned = fakeSpawn([fixture('claude-code', 'task-marker')]);
  const runner = new StructuredRunner({
    process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
  });
  const engine = new VerdictEngine();
  const verdicts: Verdict[] = [];
  const checkpoints: string[] = [];
    engine.onVerdict((_id, verdict) => verdicts.push(verdict));
    engine.onCheckpoint((_id, question) => checkpoints.push(question));
    const task = createTask({ id: 't1', title: 'Only' });
    const session = await runner.spawn({ taskId: 't1', runner: 'claude-code', mode: 'acceptEdits', prompt: 'Do it', cwd: '/repo', registry: new RunnerRegistry() });
    engine.watch(task, session);

    await new Promise<void>((resolve) => session.onTurnEnd(() => resolve()));
    expect(verdicts).toEqual([]);
    expect(checkpoints).toEqual([]);
    spawned.processes[0].exit(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].outcome).toBe('fail');
    runner.stopAll();
  });
});

describe('VerdictEngine over a Claude Code task given the Ordewell server (ADR-0022)', () => {
  const servers: OrdewellMcpServer[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await Promise.all(servers.splice(0).map((s) => s.dispose()));
  });

  /** What the CLI reads from its `--mcp-config` file. */
  function runnerConfig(args: string[]): { url: string; headers: Record<string, string> } {
    const file = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')) as {
      mcpServers: { ordewell: { url: string; headers: Record<string, string> } };
    };
    return file.mcpServers.ordewell;
  }

  async function connect({ url, headers }: { url: string; headers: Record<string, string> }): Promise<Client> {
    const client = new Client({ name: 'claude-code', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    clients.push(client);
    return client;
  }

  it('passes on a task_complete call made mid-turn, without relying on output text', async () => {
    const server = new OrdewellMcpServer();
    servers.push(server);
    const spawned = fakeSpawn([]);
  const runner = new StructuredRunner({
    process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      mcp: server,
  });
  const engine = new VerdictEngine();
  const verdicts: Verdict[] = [];
    engine.onVerdict((_taskId, verdict) => verdicts.push(verdict));
    const task = createTask({ id: 't1', title: 'Only', taskMode: 'acceptEdits' });
    const session = await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'Do the task', mode: 'acceptEdits', cwd: '/repo', registry: new RunnerRegistry(), attempt: 1 });
    engine.watch(task, session);

    const config = runnerConfig(spawned.lastArgs());
    const client = await connect(config);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Did it.' } });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].outcome).toBe('pass');
    session.kill();
    await expect(connect(config)).rejects.toThrow();
  });
});
