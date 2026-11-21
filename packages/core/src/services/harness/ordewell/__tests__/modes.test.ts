import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../../AgentAdapter';
import type { ApprovalDecision } from '../../../../interfaces/IApproval';
import { PROVIDER_PRIORITY, VENDORS } from '../../../apiProviders';
import { removeDir, setEnv } from '../../../../testEnv';
import type { ModelClient } from '../../../model';
import type { McpClientConfig } from '../../../mcp';
import { READ_ONLY_TASK_TOOLS, TASK_TOOLS, toolListing, type McpToolReply } from '../../../mcp/tools';
import { OrdewellAdapter } from '../OrdewellAdapter';
import { call, eventsOf, MemoryTranscriptStore, scriptedClient, STOP, type ScriptedStep } from './loopKit';

/*
 * The runner's modes past Full, which Ordewell enforces itself since the
 * runner has no permission system of its own (ADR-0070): Guarded asks before
 * every shell command, and read-only has no write path at all (ADR-0046).
 */

const KEY = 'sk-or-v1-modes-test-key-0123456789';
const made: string[] = [];
let restoreEnv: () => void = () => {};

beforeEach(() => {
  const cleared: Record<string, undefined> = {};
  for (const provider of PROVIDER_PRIORITY) {
    for (const name of [VENDORS[provider].apiKeyEnvVar, ...VENDORS[provider].detectEnvVars]) cleared[name] = undefined;
  }
  restoreEnv = setEnv(cleared);
});

afterEach(async () => {
  restoreEnv();
  await Promise.all(made.splice(0).map((dir) => removeDir(dir)));
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ordewell-modes-')));
  made.push(dir);
  return dir;
}

const deps: AgentProcessDeps = {
  spawn: () => {
    throw new Error('The in-process runner spawned a process.');
  },
  fetch: async () => {
    throw new Error('offline');
  },
  workspaceEnv: async () => ({ OPENROUTER_API_KEY: KEY }),
};

/** A worktree whose `node touch.mjs <name>` leaves a file behind, so a test sees whether a command ran. */
function worktree(): string {
  const dir = tempDir();
  writeFileSync(path.join(dir, 'touch.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[2] ?? 'touched', 'ran');\nconsole.log('touched ' + (process.argv[2] ?? 'touched'));\n");
  return dir;
}

function guarded(steps: readonly ScriptedStep[], cwd = worktree(), overrides: Partial<TaskStartOptions> = {}) {
  const client = scriptedClient(steps);
  const adapter = new OrdewellAdapter('openrouter', deps, {
    modelInfoTimeoutMs: 50,
    openStore: () => new MemoryTranscriptStore('modes-session', tempDir()),
    createClient: (): ModelClient => client,
  });
  const options: TaskStartOptions = { kind: 'task', cwd, model: 'openrouter:mock/test', mode: 'guarded', flags: { permissionMode: 'guarded', modeSettings: {} }, ...overrides };
  return { adapter, client, cwd, options };
}

/** Runs one turn, answering each request as `answers` says, in order. */
async function turn(adapter: OrdewellAdapter, answers: readonly ApprovalDecision[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const queue = [...answers];
  await adapter.send('Go.', (event) => {
    events.push(event);
    if (event.type === 'permission_request' && !event.decided) {
      const answer = queue.shift();
      if (answer) queueMicrotask(() => void adapter.answerPermission(event.id, answer));
    }
  });
  return events;
}

const toolResults = (events: AgentEvent[]) => eventsOf(events, 'tool_result').map(({ name, output, success }) => ({ name, output, success }));

describe('Guarded mode of the built-in runner', () => {
  it('asks before a shell command and runs it once allowed, asking again the next time', async () => {
    const { adapter, cwd, options } = guarded([
      [call('a', 'shell', { command: 'node touch.mjs one' }), STOP],
      [call('b', 'shell', { command: 'node touch.mjs one' }), STOP],
      [STOP],
    ]);
    await adapter.start(options);
    const events = await turn(adapter, [{ decision: 'allow' }, { decision: 'allow' }]);

    const asked = eventsOf(events, 'permission_request');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ name: 'shell', detail: 'node touch.mjs one', input: { command: 'node touch.mjs one' } });
    expect(asked[0]?.suggestions).toEqual([{ type: 'commandPrefix', prefix: 'node touch.mjs' }]);
    expect(existsSync(path.join(cwd, 'one'))).toBe(true);
    expect(toolResults(events).map((r) => r.success)).toEqual([true, true]);
  });

  it('Allow for this task grants the proposed prefix: plain arguments run unasked, another command asks', async () => {
    const { adapter, cwd, options } = guarded([
      [call('a', 'shell', { command: 'node touch.mjs first' }), STOP],
      [call('b', 'shell', { command: 'node  touch.mjs second' }), STOP],
      [call('c', 'shell', { command: 'node touch.mjs third > out.txt' }), STOP],
      [STOP],
    ]);
    await adapter.start(options);
    const events = await turn(adapter, [{ decision: 'allowForTask' }, { decision: 'deny' }]);

    const asked = eventsOf(events, 'permission_request');
    expect(asked.map((e) => e.detail)).toEqual(['node touch.mjs first', 'node touch.mjs third > out.txt']);
    expect(existsSync(path.join(cwd, 'first'))).toBe(true);
    expect(existsSync(path.join(cwd, 'second'))).toBe(true);
    expect(existsSync(path.join(cwd, 'out.txt'))).toBe(false);
  });

  it('a denial with a note reaches the model as a tool error it can act on, and nothing runs', async () => {
    const { adapter, client, cwd, options } = guarded([
      [call('a', 'shell', { command: 'node touch.mjs nope' }), STOP],
      [STOP],
    ]);
    await adapter.start(options);
    const events = await turn(adapter, [{ decision: 'deny', note: 'run the unit tests instead' }]);

    expect(existsSync(path.join(cwd, 'nope'))).toBe(false);
    const [result] = toolResults(events);
    expect(result).toMatchObject({ name: 'shell', success: false });
    expect(result?.output).toContain('denied');
    expect(result?.output).toContain('run the unit tests instead');
    const sent = client.requests[1]?.messages.at(-1);
    expect(sent).toMatchObject({ role: 'tool', results: [{ callId: 'a', isError: true }] });
  });

  it('edits and writes inside the worktree go ahead without asking', async () => {
    const { adapter, cwd, options } = guarded([
      [call('w', 'write', { path: 'note.txt', content: 'hello\n' }), STOP],
      [call('e', 'edit', { path: 'note.txt', oldString: 'hello', newString: 'hi' }), STOP],
      [call('r', 'read', { path: 'note.txt' }), STOP],
      [STOP],
    ]);
    await adapter.start(options);
    const events = await turn(adapter, []);
    expect(eventsOf(events, 'permission_request')).toEqual([]);
    expect(toolResults(events).map((r) => r.success)).toEqual([true, true, true]);
    expect(existsSync(path.join(cwd, 'note.txt'))).toBe(true);
  });

  it('an interrupt withdraws the open request and the command never runs', async () => {
    const { adapter, cwd, options } = guarded([[call('a', 'shell', { command: 'node touch.mjs late' }), STOP]]);
    await adapter.start(options);
    const events: AgentEvent[] = [];
    let asked = '';
    await adapter.send('Go.', (event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        asked = event.id;
        queueMicrotask(() => void adapter.interrupt(20));
      }
    });
    expect(eventsOf(events, 'permission_cancelled')).toEqual([{ type: 'permission_cancelled', id: asked }]);
    expect(await adapter.answerPermission(asked, { decision: 'allow' })).toBe(false);
    expect(existsSync(path.join(cwd, 'late'))).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
  });
});

/** The token's own listing for the tool set, answered by a fake that notes each call. */
function served(tools: typeof TASK_TOOLS): { calls: string[]; mcp: McpClientConfig } {
  const calls: string[] = [];
  return {
    calls,
    mcp: {
      name: 'ordewell', url: 'in-process', headers: {},
      inProcess: {
        list: () => toolListing(tools),
        call: async (name: string): Promise<McpToolReply> => {
          calls.push(name);
          return { text: `${name} ran` };
        },
      },
    },
  };
}

describe('read-only mode of the built-in runner (ADR-0046)', () => {
  const readOnly = { mode: 'read-only', flags: { permissionMode: 'read-only', modeSettings: {}, readOnly: true } } as const;

  it('offers no edit, write or shell, only the token\'s sealed shell, patch and web reads', async () => {
    const token = served(READ_ONLY_TASK_TOOLS);
    const { adapter, client, options } = guarded([[STOP]], worktree(), { ...readOnly, mcp: token.mcp });
    await adapter.start(options);
    await turn(adapter, []);
    const names = client.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(names).toEqual(['read', 'grep', 'glob', 'task_complete', 'read_task', 'checkpoint', 'run_command', 'save_patch', 'fetch', 'web_search']);
  });

  it('a call to a write path is an unknown tool: nothing is written and nothing asks', async () => {
    const token = served(READ_ONLY_TASK_TOOLS);
    const { adapter, cwd, options } = guarded([
      [call('w', 'write', { path: 'made.txt', content: 'x' }), call('e', 'edit', { path: 'touch.mjs', oldString: 'ran', newString: 'changed' }), call('s', 'shell', { command: 'node touch.mjs made' }), STOP],
      [call('r', 'run_command', { command: 'node touch.mjs' }), STOP],
      [STOP],
    ], worktree(), { ...readOnly, mcp: token.mcp });
    await adapter.start(options);
    const events = await turn(adapter, []);

    const results = toolResults(events);
    expect(results.slice(0, 3).map((r) => [r.name, r.success, r.output.startsWith(`Unknown tool "${r.name}"`)])).toEqual([
      ['write', false, true], ['edit', false, true], ['shell', false, true],
    ]);
    expect(eventsOf(events, 'permission_request')).toEqual([]);
    expect(existsSync(path.join(cwd, 'made.txt'))).toBe(false);
    expect(existsSync(path.join(cwd, 'made'))).toBe(false);
    expect(token.calls).toEqual(['run_command']);
  });

  it('reads the workspace root as well as its own worktree', async () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'notes.md'), 'from the workspace\n');
    const { adapter, options } = guarded([[call('r', 'read', { path: path.join(root, 'notes.md') }), STOP], [STOP]], worktree(), { ...readOnly, workspaceRoot: root });
    await adapter.start(options);
    const [result] = toolResults(await turn(adapter, []));
    expect(result).toMatchObject({ name: 'read', success: true });
    expect(result?.output).toContain('from the workspace');
  });
});

describe('a change task of the built-in runner', () => {
  it('is offered checkpoint, apply_patch and wait_for, which its token serves, and calls them in-process', async () => {
    const token = served(TASK_TOOLS);
    const { adapter, client, options } = guarded([[call('c', 'checkpoint', { question: 'Which?' }), call('p', 'apply_patch', { task: '#2' }), call('w', 'wait_for', { tasks: ['#2'], reason: 'needs its parser' }), STOP], [STOP]], worktree(), { mcp: token.mcp });
    await adapter.start(options);
    await turn(adapter, []);
    expect(client.requests[0]?.tools.map((t) => t.name).slice(-5)).toEqual(['task_complete', 'read_task', 'checkpoint', 'apply_patch', 'wait_for']);
    expect(token.calls.sort()).toEqual(['apply_patch', 'checkpoint', 'wait_for']);
  });

  // ADR-0074 P6: a wait inside the attempt is refused, pointing to the tool that parks it.
  it('refuses a long sleep in its shell, saying to call wait_for', async () => {
    const token = served(TASK_TOOLS);
    const { adapter, options } = guarded([[call('s', 'shell', { command: 'sleep 240' }), STOP], [STOP]], worktree(), { mcp: token.mcp, commits: true });
    await adapter.start(options);
    const [result] = toolResults(await turn(adapter, [{ decision: 'allow' }]));
    expect(result).toMatchObject({ name: 'shell', success: false });
    expect(result?.output).toContain('call `wait_for` with those tasks');
  });
});
