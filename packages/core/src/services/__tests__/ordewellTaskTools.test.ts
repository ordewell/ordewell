import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { OrdewellMcpServer, READ_ONLY_TASK_TOOLS, TASK_TOOLS, type McpClientConfig } from '../mcp';
import { fakeConfig } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { TaskLogEvent } from '../../models/TaskLog';
import { handoffDigest, type StoredHandoff } from '../../models/Handoff';

/**
 * A task run end to end over the real transport: the orchestrator spawns a
 * structured session, the runner is handed a token, and the "model" is an MCP
 * client calling the tools over HTTP with it (ADR-0022).
 */

class IdleAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId = 'claude-code';
  readonly exited = false;
  start_: AgentStartOptions | undefined;
  readonly prompts: string[] = [];
  private onEvent: ((event: AgentEvent) => void) | undefined;
  private exit: Array<(code: number) => void> = [];

  async start(opts: AgentStartOptions): Promise<void> { this.start_ = opts; }
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.prompts.push(message);
    this.onEvent = onEvent;
    return new Promise<void>(() => undefined);
  }
  say(text: string): void { this.onEvent?.({ type: 'assistant_text_delta', runId: 'r1', text }); }
  async interrupt(): Promise<boolean> { return false; }
  onProcessExit(listener: (code: number) => void): void { this.exit.push(listener); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return true; }
  nativeSessionId(): string | null { return null; }
  dispose(): void {}

  get config(): McpClientConfig {
    const opts = this.start_;
    if (opts?.kind !== 'task' || !opts.mcp) throw new Error('the runner was not given the server');
    return opts.mcp;
  }
}

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

/** Each task's saved attempts, oldest first, as the session's task log reader returns them. */
type SavedLogs = Record<string, TaskLogEvent[][]>;

function rig(logs: SavedLogs = {}) {
  const server = new OrdewellMcpServer({ heartbeatMs: 50 });
  servers.push(server);
  const adapters: IdleAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new IdleAdapter();
      adapters.push(adapter);
      return adapter;
    },
    interruptGraceMs: 20,
    mcp: server,
  });
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    // One saved attempt per task: enough for a dependent to read what its dependency's call recorded.
    recordHandoff: (_sessionId, taskId, handoff) => { (logs[taskId] ??= [[]]).at(-1)!.push({ type: 'handoff', handoff }); },
    taskLog: {
      attempts: (taskId) => (logs[taskId] ?? []).map((_, i) => i + 1),
      events: (taskId, attempt) => logs[taskId]?.[attempt - 1] ?? [],
    },
  });
  const get = (id: string): Task => orchestrator.storeInstance.get(id)!;
  return { orchestrator, adapters, server, get };
}

async function connect(config: McpClientConfig): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  clients.push(client);
  return client;
}

/** A tool result's text, as the runner reads it. */
function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
}

const task = (id: string, order: number, extra: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...extra });

describe('task_complete over HTTP, through the orchestrator', () => {
  it.each([
    ['done', 'completed'],
    ['blocked', 'failed'],
    ['failed', 'failed'],
  ] as const)('%s ends the attempt as %s, with the reason on the verdict', async (status, final) => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.forceStartTask('t1');

    const client = await connect(adapters[0].config);
    const reason = status === 'done' ? undefined : 'the schema file is missing';
    const result = await client.callTool({ name: 'task_complete', arguments: { status, summary: 'What happened.', ...(reason ? { reason } : {}) } });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe(final));
    if (reason) expect(get('t1').verdict?.reason).toContain(reason);
    else expect(get('t1').verdict?.checks[0].name).toBe('task_complete');
  });

  it('gives one verdict when more output arrives after the completion call', async () => {
    const { orchestrator, adapters, get } = rig();
    const settled: string[] = [];
    orchestrator.loadPlan([task('t1', 1)]);
    orchestrator.subscribe({ onTaskSettled: ({ taskId }) => settled.push(taskId) });
    await orchestrator.forceStartTask('t1');

    const client = await connect(adapters[0].config);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Built it.' } });
    adapters[0].say('Done.');
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toEqual(['t1']);
    expect(get('t1').verdict?.checks[0].name).toBe('task_complete');
  });

  it('rejects a stale attempt\'s token once the task is retried, and accepts the new attempt\'s', async () => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.forceStartTask('t1');
    const stale = adapters[0].config;

    await orchestrator.retryTask('t1');
    await orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(adapters).toHaveLength(2));

    await expect(connect(stale)).rejects.toThrow();
    expect(get('t1').status).not.toBe('completed');

    const client = await connect(adapters[1].config);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Second try.' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
  });

  it('keeps one task\'s token to that task: it completes its own and cannot reach another', async () => {
    const { orchestrator, adapters, get, server } = rig();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
    await orchestrator.forceStartTask('t1');
    await orchestrator.forceStartTask('t2');
    const [first, second] = adapters.map((a) => a.config);
    expect(first.headers).not.toEqual(second.headers);

    const client = await connect(first);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'One is done.' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));

    expect(get('t2').status).toBe('in_progress');
    // The finished task's token is revoked with it; the other's is untouched.
    await expect(connect(first)).rejects.toThrow();
    await expect(connect(second)).resolves.toBeDefined();
    await server.dispose();
  });

  it('keeps the token out of every prompt, the dependent\'s included, and hands the summary on', async () => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(adapters).toHaveLength(1));
    await vi.waitFor(() => expect(adapters[0].start_).toBeDefined());
    const first = adapters[0].config;
    const client = await connect(first);

    await client.callTool({
      name: 'task_complete',
      arguments: { status: 'done', summary: 'Wrote the parser.' },
    });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    await vi.waitFor(() => expect(adapters).toHaveLength(2));
    await vi.waitFor(() => expect(adapters[1].prompts).toHaveLength(1));

    const authorization = Object.values(first.headers).join(' ');
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    expect(token.length).toBeGreaterThan(20);
    for (const adapter of adapters) {
      for (const prompt of adapter.prompts) expect(prompt).not.toContain(token);
    }
    const dependentPrompt = adapters[1].prompts[0];
    expect(dependentPrompt).toContain('Wrote the parser.');
  });
});

describe('checkpoint over HTTP, through the orchestrator', () => {
  const hitl = () => [task('t1', 1, { autonomy: 'HITL' })];

  async function asking() {
    const rigged = rig();
    rigged.orchestrator.loadPlan(hitl());
    await rigged.orchestrator.forceStartTask('t1');
    const client = await connect(rigged.adapters[0].config);
    return { ...rigged, client };
  }

  it('waits until the user approves, then answers the call', async () => {
    const { orchestrator, client, get } = await asking();
    let settled = false;
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } }).then((r) => { settled = true; return r; });

    await vi.waitFor(() => expect(get('t1').status).toBe('awaiting_user'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);

    orchestrator.approveCheckpoint('t1');
    const result = await call;

    expect(result.isError).toBe(false);
    expect(get('t1').status).toBe('in_progress');
  });

  it('waits until the user rejects, then answers the call with the reason', async () => {
    const { orchestrator, client, get } = await asking();
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('awaiting_user'));

    orchestrator.rejectCheckpoint('t1', 'not on production');

    expect(await call).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('not on production') }] });
  });

  it('is withdrawn, not left hanging, when the task is retried', async () => {
    const { orchestrator, client, get } = await asking();
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('awaiting_user'));

    await orchestrator.retryTask('t1');

    expect(await call).toMatchObject({ isError: true });
  });
});

describe('the handoff a task_complete call carries (ADR-0047)', () => {
  async function completing(plan: Task[] = [task('t1', 1)], taskId = 't1') {
    const rigged = rig();
    rigged.orchestrator.loadPlan(plan);
    await rigged.orchestrator.forceStartTask(taskId);
    const client = await connect(rigged.adapters.at(-1)!.config);
    const complete = (args: Record<string, unknown>) => client.callTool({ name: 'task_complete', arguments: { status: 'done', ...args } });
    return { ...rigged, client, complete };
  }

  it('starts a change task\'s runner told to write its commit, and an ops task\'s not', async () => {
    const { orchestrator, adapters } = rig();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { ops: true })]);

    await orchestrator.forceStartTask('t1');
    await orchestrator.forceStartTask('t2');
    await vi.waitFor(() => expect(adapters.map((a) => a.start_ !== undefined)).toEqual([true, true]));

    expect(adapters.map((a) => a.start_?.kind === 'task' && a.start_.commits === true)).toEqual([true, false]);
  });

  it('keeps a call that sends only a summary as a handoff with no findings', async () => {
    const { complete, get } = await completing();

    const result = await complete({ summary: 'Added the cache; eviction is still missing.' });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff).toEqual({ summary: 'Added the cache; eviction is still missing.', findings: [], findingCount: 0 });
  });

  it('keeps the commit a done call states, subject and body, in the handoff', async () => {
    const { complete, get } = await completing();

    const result = await complete({
      summary: 'The check lives in core/src/version.ts.',
      commit: { subject: 'Add a daily version check behind ORDEWELL_NO_VERSION_CHECK', body: 'Users ran stale builds for weeks without knowing.' },
    });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff).toEqual({
      commit: { subject: 'Add a daily version check behind ORDEWELL_NO_VERSION_CHECK', body: 'Users ran stale builds for weeks without knowing.' },
      summary: 'The check lives in core/src/version.ts.',
      findings: [],
      findingCount: 0,
    });
  });

  it.each(['blocked', 'failed'])('ignores the commit of a %s call: its summary carries everything', async (status) => {
    const { complete, get } = await completing();

    await complete({ status, reason: 'The schema is missing.', summary: 'Half the parser is written.', commit: { subject: 'Add the parser' } });

    await vi.waitFor(() => expect(get('t1').status).toBe('failed'));
    expect(get('t1').handoff).toEqual({ summary: 'Half the parser is written.', findings: [], findingCount: 0 });
  });

  it.each([
    ['a subject of two lines', { subject: 'Add the check\nand its setting' }, /commit subject is one line/],
    ['a subject past 100 characters', { subject: 'A'.repeat(101) }, /commit\.subject is 101 characters; the limit is 100, 1 over: cut at least 1 character\. Keep it to 72 or fewer/],
    ['an empty subject', { subject: '  ' }, /commit subject is required/],
    ['a body past 500 characters', { subject: 'Add the check', body: 'x'.repeat(501) }, /commit\.body is 501 characters; the limit is 500, 1 over: cut at least 1 character\./],
  ])('refuses %s, saying what to fix, and keeps the attempt open for a resend', async (_name, commit, says) => {
    const { complete, get } = await completing();

    const refused = await complete({ summary: 'Done.', commit });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(says);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t1').status).toBe('in_progress');
    expect((await complete({ summary: 'Done.', commit: { subject: 'Add the check', body: 'x'.repeat(500) } })).isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
  });

  it('numbers the findings F1 to Fn in the order the author gave them, and keeps the artifacts', async () => {
    const { complete, get } = await completing();

    const result = await complete({
      summary: 'Reviewed the cache.',
      findings: [
        { severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 12 }] },
        { severity: 'info', title: 'The README still says v1' },
        { severity: 'minor', title: 'A stale comment', evidence: [{ kind: 'commit', sha: 'a1b2c3d' }, { kind: 'url', url: 'https://example.com/ttl' }] },
      ],
      artifacts: [{ kind: 'file', path: 'docs/cache-review.md' }],
    });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff).toEqual({
      summary: 'Reviewed the cache.',
      findings: [
        { id: 'F1', severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 12 }] },
        { id: 'F2', severity: 'info', title: 'The README still says v1' },
        { id: 'F3', severity: 'minor', title: 'A stale comment', evidence: [{ kind: 'commit', sha: 'a1b2c3d' }, { kind: 'url', url: 'https://example.com/ttl' }] },
      ],
      findingCount: 3,
      artifacts: [{ kind: 'file', path: 'docs/cache-review.md' }],
    });
  });

  it('refuses a summary past its limit, naming the field and where the rest goes, and keeps the attempt open for a resend', async () => {
    const { complete, get } = await completing();

    const refused = await complete({ summary: 'x'.repeat(1_501) });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/summary/);
    expect(text(refused)).toMatch(/the limit is 1500, 1 over: cut at least 1 character\. Put the long form in report/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t1').status).toBe('in_progress');

    expect((await complete({ summary: 'Short.', report: 'x'.repeat(1_501) })).isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff?.summary).toBe('Short.');
  });

  it('refuses a URL that is not http or https, naming the field, the value and what is accepted, and records nothing', async () => {
    const { complete, get } = await completing();

    const refused = await complete({
      summary: 'Reviewed.',
      findings: [{ severity: 'major', title: 'XSS', evidence: [{ kind: 'file', path: 'a.ts' }, { kind: 'url', url: 'javascript:alert(1)' }] }],
    });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('findings[0].evidence[1].url');
    expect(text(refused)).toContain('"javascript:alert(1)"');
    expect(text(refused)).toMatch(/only an http or https URL/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t1').status).toBe('in_progress');
    expect(get('t1').handoff).toBeUndefined();
  });

  it('names a cited task by its id, and refuses a task this one may not read, one not in the plan, or a finding it never had', async () => {
    const done = task('t1', 1, { status: 'completed', handoff: { summary: 'Wrote it.', findings: [], findingCount: 2 } });
    const { complete, get } = await completing([done, task('t2', 2, { dependencies: ['t1'] }), task('t3', 3)], 't2');

    const refused = await complete({
      summary: 'Checked.',
      findings: [{ severity: 'major', title: 'Still broken', evidence: [{ kind: 'task', task: '#3' }, { kind: 'task', task: '#9' }, { kind: 'task', task: '#1', finding: 'F3' }] }],
    });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('findings[0].evidence[0].task: "#3" is #3 Task t3, which this task may not read: only itself, a task it depends on, or its loop\'s other end.');
    expect(text(refused)).toContain('findings[0].evidence[1].task: "#9" names no task in the plan');
    expect(text(refused)).toContain('findings[0].evidence[2].finding: "F3" is not a finding of #1 Task t1: its latest handoff has F1 to F2.');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t2').status).toBe('in_progress');

    const accepted = await complete({
      summary: 'Checked.',
      findings: [{ severity: 'major', title: 'Still broken', evidence: [{ kind: 'task', task: '#1', finding: 'F2' }] }],
      artifacts: [{ kind: 'task', task: 't2' }],
    });
    expect(accepted.isError).toBe(false);
    await vi.waitFor(() => expect(get('t2').status).toBe('completed'));
    expect(get('t2').handoff?.findings[0].evidence).toEqual([{ kind: 'task', task: 't1', finding: 'F2' }]);
    expect(get('t2').handoff?.artifacts).toEqual([{ kind: 'task', task: 't2' }]);
  });

  it('lets a loop\'s check cite its body, and a body task cite its check', async () => {
    const check = task('c', 1, { loop: { body: ['b'], maxRounds: 2 } });
    const body = task('b', 2, { dependencies: ['c'], status: 'completed', handoff: { summary: 'Fixed F1.', findings: [], findingCount: 0 } });
    const { complete, get } = await completing([check, body], 'c');

    const result = await complete({ summary: 'The fix holds.', findings: [{ severity: 'info', title: 'Verified', evidence: [{ kind: 'task', task: '#2' }] }] });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('c').status).toBe('completed'));
    expect(get('c').handoff?.findings[0].evidence).toEqual([{ kind: 'task', task: 'b' }]);
  });

  it('keeps the first 25 findings and no report on the plan, counting every finding', async () => {
    const { complete, get } = await completing();
    const findings = Array.from({ length: 30 }, (_, i) => ({ severity: 'minor', title: `Finding ${i + 1}` }));

    expect((await complete({ summary: 'Thirty things.', findings, report: 'The long form.' })).isError).toBe(false);

    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    const { handoff } = get('t1');
    expect(handoff?.findingCount).toBe(30);
    expect(handoff?.findings.map((f) => f.id)).toEqual(Array.from({ length: 25 }, (_, i) => `F${i + 1}`));
    expect(handoff).not.toHaveProperty('report');
  });

  it('keeps the long report out of the plan and gives a dependent the full handoff through read_task', async () => {
    const done = task('t1', 1, { status: 'completed' });
    const { complete, get, orchestrator, adapters } = await completing([done, task('t2', 2, { dependencies: ['t1'] })], 't2');

    await complete({
      summary: 'Reviewed the cache.',
      findings: [
        { severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.\nset() too.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 12 }, { kind: 'task', task: 't1' }] },
        { severity: 'info', title: 'The README still says v1', evidence: [{ kind: 'commit', sha: 'a1b2c3d', repo: 'api' }, { kind: 'url', url: 'https://example.com/ttl' }] },
      ],
      artifacts: [{ kind: 'file', path: 'docs/review.md' }],
      report: 'The long form.',
    });

    await vi.waitFor(() => expect(get('t2').status).toBe('completed'));
    expect(get('t2').outputSummary?.report).toBeUndefined();
    orchestrator.loadPlan([...orchestrator.storeInstance.snapshot(), task('t3', 3, { dependencies: ['t2'] })]);
    await orchestrator.forceStartTask('t3');
    const reader = await connect(adapters.at(-1)!.config);
    const pulled = await reader.callTool({ name: 'read_task', arguments: { task: 't2', include_report: true } });
    expect(text(pulled)).toContain([
      'Reviewed the cache.',
      '',
      'Findings:',
      '- F1 [blocker] Entries never expire',
      '  get() ignores the TTL.',
      '  set() too.',
      '  Evidence: src/cache.ts:12 (unresolved); task #1',
      '- F2 [info] The README still says v1',
      '  Evidence: commit a1b2c3d in api (unresolved); https://example.com/ttl',
      '',
      'Artifacts: docs/review.md (unresolved)',
      '',
      'Report:',
      'The long form.',
    ].join('\n'));
  });

  it('starts a retry without the handoff of the attempt before it', async () => {
    const { orchestrator, complete, get } = await completing();
    await complete({ status: 'failed', summary: 'The schema is missing.' });
    await vi.waitFor(() => expect(get('t1').status).toBe('failed'));
    expect(get('t1').handoff?.summary).toBe('The schema is missing.');

    await orchestrator.retryTask('t1');

    expect(get('t1').handoff).toBeUndefined();
  });
});

describe('read_task over HTTP: a task pulls a handoff it may read (ADR-0047)', () => {
  async function reading(plan: Task[], readerId: string, logs: SavedLogs = {}) {
    const rigged = rig(logs);
    rigged.orchestrator.loadPlan(plan);
    await rigged.orchestrator.forceStartTask(readerId);
    const client = await connect(rigged.adapters.at(-1)!.config);
    const read = (args: Record<string, unknown>) => client.callTool({ name: 'read_task', arguments: args });
    return { ...rigged, read };
  }

  const thirty: StoredHandoff = {
    summary: 'Thirty things.',
    findings: Array.from({ length: 30 }, (_, i) => ({ id: `F${i + 1}`, severity: 'minor' as const, title: `Finding ${i + 1}` })),
    findingCount: 30,
    report: 'The long form.',
  };

  it('returns every finding from the attempt\'s log, past the plan\'s first 25, and the report only when asked for', async () => {
    const done = task('t1', 1, { status: 'completed', handoff: handoffDigest(thirty) });
    const { read } = await reading([done, task('t2', 2, { dependencies: ['t1'] })], 't2', { t1: [[{ type: 'handoff', handoff: thirty }]] });

    const plain = await read({ task: '#1' });

    expect(plain.isError).toBe(false);
    expect(text(plain)).toBe([
      '#1 Task t1, attempt 1 of 1:',
      '',
      'Thirty things.',
      '',
      'Findings:',
      ...Array.from({ length: 30 }, (_, i) => `- F${i + 1} [minor] Finding ${i + 1}`),
      '',
      'It also wrote a report of 14 characters, left out here: call read_task again with include_report: true to read it.',
    ].join('\n'));

    const whole = await read({ task: '#1', include_report: true });

    expect(text(whole)).toContain('- F30 [minor] Finding 30\n\nReport:\nThe long form.');
    expect(text(whole)).not.toContain('left out here');
  });

  it('reads a dependency of a dependency, and refuses a sibling it was never given, naming what it may read', async () => {
    const handed = (summary: string): StoredHandoff => ({ summary, findings: [], findingCount: 0 });
    const plan = [
      task('a', 1, { status: 'completed', handoff: handed('First.') }),
      task('b', 2, { dependencies: ['a'], status: 'completed', handoff: handed('Second.') }),
      task('c', 3, { dependencies: ['b'] }),
      task('d', 4, { dependencies: ['a'], status: 'completed', handoff: handed('Sibling.') }),
    ];
    const { read } = await reading(plan, 'c', { a: [[{ type: 'handoff', handoff: handed('First.') }]], d: [[{ type: 'handoff', handoff: handed('Sibling.') }]] });

    expect(text(await read({ task: '#1' }))).toContain('First.');

    const refused = await read({ task: 'Task d' });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('#4 Task d is not a task this one may read. It may read itself, the tasks it depends on, directly or not, and its loop\'s other end: #1 Task a, #2 Task b and #3 Task c.');
    expect(text(refused)).not.toContain('Sibling.');
  });

  it('lets a loop\'s check read its body task, which does not depend on it the other way', async () => {
    const fixed: StoredHandoff = { summary: 'Fixed F1 of #1.', findings: [], findingCount: 0 };
    const plan = [
      task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }),
      task('fix', 2, { dependencies: ['check'], status: 'completed', handoff: fixed }),
      task('other', 3, { status: 'completed' }),
    ];
    const { read } = await reading(plan, 'check', { fix: [[{ type: 'handoff', handoff: fixed }]] });

    expect(text(await read({ task: '#2' }))).toBe('#2 Task fix, attempt 1 of 1:\n\nFixed F1 of #1.');
    expect((await read({ task: '#3' })).isError).toBe(true);
  });

  it('says when a task has no handoff, and gives what the plan keeps of it instead', async () => {
    const old = task('old', 1, { status: 'completed', outputSummary: { reviewReason: 'Verified', report: 'The old free text.', logTail: '', capturedAt: 'x' } });
    const { read } = await reading([old, task('next', 2, { dependencies: ['old'] })], 'next', { old: [[{ type: 'turn_end', reason: 'completed' }]] });

    const answer = await read({ task: '#1' });

    expect(answer.isError).toBeFalsy();
    expect(text(answer)).toBe([
      '#1 Task old has no handoff from attempt 1 of 1: it ended without a task_complete call, or ran before handoffs. Its output summary, as the plan keeps it:',
      '',
      'Review: Verified',
      'Report:',
      'The old free text.',
    ].join('\n'));
  });

  it('gives a dependent what its dependency\'s task_complete call recorded, the tasks it cites named', async () => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.forceStartTask('t1');
    const producer = await connect(adapters[0].config);
    await producer.callTool({ name: 'task_complete', arguments: {
      status: 'done', summary: 'Reviewed.', report: 'All of it.',
      findings: [{ severity: 'major', title: 'A hole', evidence: [{ kind: 'task', task: 't1' }] }],
    } });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    await orchestrator.forceStartTask('t2');

    const reader = await connect(adapters[1].config);
    const answer = await reader.callTool({ name: 'read_task', arguments: { task: 't1', include_report: true } });

    expect(text(answer)).toBe('#1 Task t1, attempt 1 of 1:\n\nReviewed.\n\nFindings:\n- F1 [major] A hole\n  Evidence: task #1\n\nReport:\nAll of it.');
  });

  it('never returns the end of a task\'s output in place of a handoff: that is output, not what it handed over', async () => {
    const quiet = task('quiet', 1, { status: 'completed', outputSummary: { reviewReason: 'The script exited with code 0.', logTail: '12 passing', capturedAt: 'x' } });
    const { read } = await reading([quiet, task('next', 2, { dependencies: ['quiet'] })], 'next', { quiet: [[]] });

    expect(text(await read({ task: '#1' }))).toBe([
      '#1 Task quiet has no handoff from attempt 1 of 1: it ended without a task_complete call, or ran before handoffs. Its output summary, as the plan keeps it:',
      '',
      'Review: The script exited with code 0.',
    ].join('\n'));
  });

  it('reads an earlier attempt when asked, and names the saved attempts when asked for one there is not', async () => {
    const first: StoredHandoff = { summary: 'First try.', findings: [], findingCount: 0 };
    const second: StoredHandoff = { summary: 'Second try.', findings: [], findingCount: 0 };
    const done = task('t1', 1, { status: 'completed', handoff: second });
    const logs: SavedLogs = { t1: [[{ type: 'handoff', handoff: first }], [{ type: 'handoff', handoff: second }]] };
    const { read } = await reading([done, task('t2', 2, { dependencies: ['t1'] })], 't2', logs);

    expect(text(await read({ task: '#1' }))).toBe('#1 Task t1, attempt 2 of 2:\n\nSecond try.');
    expect(text(await read({ task: '#1', attempt: 1 }))).toBe('#1 Task t1, attempt 1 of 2:\n\nFirst try.');
    const missing = await read({ task: '#1', attempt: 3 });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe('#1 Task t1 has no saved attempt 3: its saved attempts are 1 and 2.');
  });

  it('says a task reading itself mid-attempt has handed nothing over yet', async () => {
    const { read } = await reading([task('t1', 1)], 't1');

    expect(text(await read({ task: '#1' }))).toBe('#1 Task t1 has no handoff yet: it is still running.');
  });

  it('falls back to the plan\'s digest where no saved log holds the handoff, as in a forked session', async () => {
    const done = task('t1', 1, { status: 'completed', handoff: handoffDigest(thirty) });
    const { read } = await reading([done, task('t2', 2, { dependencies: ['t1'] })], 't2');

    const answer = text(await read({ task: '#1' }));

    expect(answer.startsWith('#1 Task t1: no saved log of this session holds its handoff, so this is what the plan keeps of it.\n\nThirty things.\n')).toBe(true);
    expect(answer).toContain('- F25 [minor] Finding 25\n\nIts other 5 findings, and any report, were not kept in the plan.');
    expect(answer).not.toContain('F26');
    expect(answer).not.toContain("in the attempt's log");
  });

  it('is on a read-only task\'s token too: it reads Ordewell\'s record, not the tree', async () => {
    expect(READ_ONLY_TASK_TOOLS.map((t) => t.name)).toEqual(['task_complete', 'checkpoint', 'read_task', 'run_command', 'save_patch', 'fetch', 'web_search']);
    expect(TASK_TOOLS.find((t) => t.name === 'read_task')?.annotations).toEqual({ readOnlyHint: true });
  });
});
