import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OrdewellMcpServer, PLANNER_EXECUTION_TOOLS, mcpClientConfig } from '../mcp';
import { plannerToolHandler, type PlannerToolsHost } from '../plannerTools';
import { executionToolSpecs, toGeminiToolDeclarations, toOpenAiTools } from '../researchTools';
import type { CommandOutcome, ExecutionCommand } from '../ExecutionCommands';

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

function host(execute: (command: ExecutionCommand) => Promise<CommandOutcome>, turnId: () => string | undefined = () => 'turn-1'): PlannerToolsHost {
  const unused = async (): Promise<never> => { throw new Error('not used here'); };
  return {
    skills: () => [], turnId, recordSkillLoad: () => false, liveCatalog: unused, checkPlan: unused,
    submitPlan: unused, editPlan: unused, tasks: () => [], read: unused, liveOutput: () => null, lastAttempt: () => null,
    taskLogAttempts: () => [], taskLog: () => [], taskDiff: unused,
    runCommand: unused, fetchUrl: unused, webSearch: unused,
    execute,
  };
}

async function connected(planner: PlannerToolsHost): Promise<Client> {
  const server = new OrdewellMcpServer();
  servers.push(server);
  const config = mcpClientConfig(await server.issuePlannerToken({ sessionId: 's1' }, plannerToolHandler(planner)));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  clients.push(client);
  return client;
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) => (result.content as Array<{ text: string }>)[0].text;

describe('the execution tools on the Ordewell MCP server', () => {
  it('hands each call to the command seam as one command, a task named by order included', async () => {
    const execute = vi.fn(async (_command: ExecutionCommand): Promise<CommandOutcome> => ({ ok: true, message: 'done' }));
    const client = await connected(host(execute));

    await client.callTool({ name: 'run_plan', arguments: {} });
    await client.callTool({ name: 'run_task', arguments: { task: 2 } });
    await client.callTool({ name: 'stop_task', arguments: { task: '#3' } });
    await client.callTool({ name: 'stop_run', arguments: {} });
    await client.callTool({ name: 'retry_task', arguments: { task: 't4', from: 'session', message: 'finish the docs' } });
    await client.callTool({ name: 'message_task', arguments: { task: 't4', text: 'use the cache' } });
    const answered = await client.callTool({ name: 'answer_approval', arguments: { task: 't4', answer: 'deny', note: 'not that' } });
    await client.callTool({ name: 'merge_all', arguments: {} });
    await client.callTool({ name: 'answer_checkpoint', arguments: { task: 't4', answer: 'reject', reason: 'not on production' } });
    await client.callTool({ name: 'answer_checkpoint', arguments: { task: '#2', answer: 'approve' } });

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      { command: 'run_plan' },
      { command: 'run_task', task: '2' },
      { command: 'stop_task', task: '#3' },
      { command: 'stop_run' },
      { command: 'retry_task', task: 't4', from: 'session', message: 'finish the docs' },
      { command: 'message_task', task: 't4', text: 'use the cache' },
      { command: 'answer_approval', task: 't4', answer: 'deny', note: 'not that' },
      { command: 'merge_all' },
      { command: 'answer_checkpoint', task: 't4', answer: 'reject', reason: 'not on production' },
      { command: 'answer_checkpoint', task: '#2', answer: 'approve' },
    ]);
    expect(answered.isError).toBe(false);
    expect(JSON.parse(text(answered))).toEqual({ ok: true, result: 'done' });
  });

  it('takes only "approve" or "reject" as a checkpoint answer, and says who may answer and that answer_approval does not cover it', async () => {
    const execute = vi.fn(async (): Promise<CommandOutcome> => ({ ok: true, message: 'done' }));
    const client = await connected(host(execute));

    const bad = await client.callTool({ name: 'answer_checkpoint', arguments: { task: 't1', answer: 'allow' } });
    const tools = (await client.listTools()).tools;
    const description = (name: string) => tools.find((t) => t.name === name)!.description;

    expect(bad.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(description('answer_checkpoint')).toMatch(/Only the supervisor at Act may, in a wake-up turn/);
    expect(description('answer_checkpoint')).toMatch(/escalate|judgement/i);
    expect(description('answer_approval')).toMatch(/does not cover a checkpoint/);
  });

  it('hands run_script to the seam as one command, with the call\'s own cancellation (ADR-0035)', async () => {
    const execute = vi.fn(async (_command: ExecutionCommand, _signal?: AbortSignal): Promise<CommandOutcome> => ({ ok: true, message: 'Ran script task #2 "Push". It passed.' }));
    const client = await connected(host(execute));

    const result = await client.callTool({ name: 'run_script', arguments: { title: 'Push', commands: [['git', 'push', 'origin', 'main']], timeoutMs: 30_000, dependencies: [1, '#2'] } });

    expect(execute.mock.calls[0][0]).toEqual({ command: 'run_script', title: 'Push', commands: [['git', 'push', 'origin', 'main']], timeoutMs: 30_000, dependencies: ['1', '#2'] });
    expect(execute.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(text(result))).toEqual({ ok: true, result: 'Ran script task #2 "Push". It passed.' });
  });

  it('lets an "allow" reach the seam, so the refusal says why rather than a schema error', async () => {
    const execute = vi.fn(async (): Promise<CommandOutcome> => ({ ok: false, outcome: 'refused', message: 'answer_approval never allows.' }));
    const client = await connected(host(execute));

    const result = await client.callTool({ name: 'answer_approval', arguments: { task: 't1', answer: 'allow' } });

    expect(execute).toHaveBeenCalledWith({ command: 'answer_approval', task: 't1', answer: 'allow' }, undefined);
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({ ok: false, outcome: 'refused', reason: 'answer_approval never allows.' });
  });

  it('refuses a call made outside a planner turn without reaching the seam', async () => {
    const execute = vi.fn();
    const client = await connected(host(execute, () => undefined));

    const result = await client.callTool({ name: 'stop_run', arguments: {} });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No planning turn is open');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('the execution tools as the API planner declares them', () => {
  it('take the arguments the MCP tools take', () => {
    const specs = executionToolSpecs();

    expect(specs.map((s) => s.name)).toEqual(PLANNER_EXECUTION_TOOLS.map((t) => t.name));
    for (const spec of specs) {
      const schema = PLANNER_EXECUTION_TOOLS.find((t) => t.name === spec.name)!.inputSchema;
      expect(Object.keys(spec.properties), spec.name).toEqual(Object.keys((schema.properties ?? {}) as object));
      expect(spec.required, spec.name).toEqual(schema.required ?? []);
    }
    const retry = specs.find((s) => s.name === 'retry_task')!;
    expect(retry.required).toEqual(['task', 'from']);
    expect(retry.properties.from).toMatchObject({ type: 'string', enum: ['fresh', 'session'] });
    expect(retry.properties.task.type).toBe('string');
  });

  it('declare run_script\'s commands as a list of argument vectors, which a provider refuses an array not to say', () => {
    const spec = executionToolSpecs().find((s) => s.name === 'run_script')!;
    const openAi = toOpenAiTools(true).find((t) => t.function.name === 'run_script')!;
    const gemini = toGeminiToolDeclarations(true).find((d) => d.name === 'run_script')!;

    expect(spec.required).toEqual(['title']);
    expect(spec.properties.commands).toMatchObject({ type: 'array', items: { type: 'array', items: { type: 'string' } } });
    expect(spec.properties.dependencies).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(openAi.function.parameters).toMatchObject({ properties: { commands: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } });
    expect(gemini.parameters).toMatchObject({ properties: { commands: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } });
  });

  it('are offered to an OpenAI-compatible conversation only when asked for', () => {
    const names = (execution: boolean) => toOpenAiTools(execution).map((t) => t.function.name);

    expect(names(true)).toEqual(expect.arrayContaining(['run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'message_task', 'answer_approval', 'merge_all']));
    expect(names(false)).not.toContain('run_task');
  });

  it('declare no parameters to Gemini for a tool that takes none, which Gemini would refuse as an empty object', () => {
    const declarations = toGeminiToolDeclarations(true);

    expect(declarations.find((d) => d.name === 'run_plan')).toEqual({ name: 'run_plan', description: expect.any(String) });
    expect(declarations.find((d) => d.name === 'stop_task')!.parameters).toMatchObject({ properties: { task: { type: 'string' } }, required: ['task'] });
    expect(toGeminiToolDeclarations().map((d) => d.name)).not.toContain('run_plan');
  });
});
