import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import type { AgentEvent, AgentProcessDeps } from '../harness/AgentAdapter';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import { plannedMode, readOnlyRunners, taggedReadOnlyMode } from '../ModeResolver';
import { resolveAssignment } from '../TaskAssignment';
import { createTask } from '../../models/Task';
import { mcpClientConfig } from '../mcp';
import { decideReadOnlyTaskPermission } from '../harness/plannerPermissions';
import { codexAnswer, fakeSpawn, fixture, type ScriptedReply } from './harnessTestKit';

const mcp = mcpClientConfig({ token: 'test', url: 'http://127.0.0.1:4555/mcp', readOnly: true });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function deps(replies: ScriptedReply[] = []) {
  const spawned = fakeSpawn(replies, { probe: () => ({ code: 1, output: 'bwrap: user namespace unavailable' }) });
  const processDeps: AgentProcessDeps = {
    spawn: spawned.spawn, fetch: globalThis.fetch, resolvePath: async () => '/usr/bin', platform: 'linux',
    isDirectory: () => true, exists: () => true, workspaceEnv: async () => ({}),
  };
  return { spawned, processDeps };
}

describe('read-only runner profiles (ADR-0046)', () => {
  it('resolves every built-in to the profile at either level, preserving the assigned model', () => {
    const manifests = [CLAUDE_CODE_MANIFEST, CODEX_MANIFEST, OPENCODE_MANIFEST];
    const runnerModes = Object.fromEntries(manifests.map((m) => [m.name, m.modes ?? []]));
    expect(readOnlyRunners(runnerModes)).toEqual(manifests.map((m) => m.name));
    for (const manifest of manifests) {
      const mode = taggedReadOnlyMode(manifest.modes);
      for (const autonomousDefault of [true, false]) {
        expect(plannedMode(manifest.name, runnerModes, { readOnly: true }, autonomousDefault)).toEqual({ ok: true, mode });
        const assignedModel = { modelId: 'chosen-model', modelLabel: 'Chosen', thinkingEffort: 'high' };
        const outcome = resolveAssignment({ writer: 'plan', task: createTask({ title: 'Review', assignedRunner: manifest.name, assignedModel }), readOnly: true, catalog: { runnerModes, modelsByRunner: {}, autonomousDefault } });
        expect(outcome).toMatchObject({ ok: true, task: { taskMode: mode, assignedModel }, adjustments: [] });
        expect(resolveTaskRunnerFlags(manifest, { mode: mode! })).toMatchObject({ readOnly: true });
      }
    }
  });

  it('refuses a native web read and points at Ordewell\'s fetch and web_search, never at a person', () => {
    const site = { cwd: '/task', workspaceRoot: '/workspace' };
    for (const ask of [{ kind: 'fetch', url: 'https://example.test' }, { kind: 'search', query: 'docs', provider: 'anthropic' }] as const) {
      expect(decideReadOnlyTaskPermission(ask, site)).toEqual({ decision: 'deny', note: 'This native tool is unavailable on a read-only task. Use Ordewell run_command for commands, and Ordewell fetch and web_search for the web; nobody can approve native tools here.' });
    }
  });

  it('allows real paths in either root and refuses links escaping both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-read-roots-'));
    dirs.push(dir);
    const cwd = join(dir, 'task');
    const workspaceRoot = join(dir, 'workspace');
    for (const root of [cwd, workspaceRoot]) { mkdirSync(root); writeFileSync(join(root, 'inside'), 'ok'); }
    writeFileSync(join(dir, 'outside'), 'secret');
    symlinkSync(join(dir, 'outside'), join(cwd, 'escape'));
    symlinkSync(join(workspaceRoot, 'inside'), join(cwd, 'workspace-link'));
    for (const path of ['inside', 'workspace-link', join(workspaceRoot, 'inside')]) {
      expect(decideReadOnlyTaskPermission({ kind: 'path', path, directory: false }, { cwd, workspaceRoot })).toEqual({ decision: 'allow' });
    }
    for (const path of ['escape', join(dir, 'outside')]) {
      expect(decideReadOnlyTaskPermission({ kind: 'path', path, directory: false }, { cwd, workspaceRoot })).toMatchObject({ decision: 'deny' });
    }
  });

  it('keeps a confined read, a language server\'s, to the task worktree, as it was before it was asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-read-confined-'));
    dirs.push(dir);
    const cwd = join(dir, 'task');
    const workspaceRoot = join(dir, 'workspace');
    for (const root of [cwd, workspaceRoot]) { mkdirSync(root); writeFileSync(join(root, 'inside'), 'ok'); }
    expect(decideReadOnlyTaskPermission({ kind: 'path', path: 'inside', directory: false, confined: true }, { cwd, workspaceRoot })).toEqual({ decision: 'allow' });
    expect(decideReadOnlyTaskPermission({ kind: 'path', path: join(workspaceRoot, 'inside'), directory: false, confined: true }, { cwd, workspaceRoot })).toMatchObject({ decision: 'deny' });
  });

  it('starts Claude without native writes, shell, plan mode or hooks, and decides every native request', async () => {
    const { spawned, processDeps } = deps();
    const adapter = new ClaudeCodeAdapter(processDeps);
    try {
      await adapter.start({ kind: 'task', cwd: '/task', workspaceRoot: '/workspace', model: 'haiku', mode: 'plan', flags: resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode: 'plan' }), mcp });
      const args = spawned.lastArgs();
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
      expect(args[args.indexOf('--model') + 1]).toBe('haiku');
      expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'KillShell', 'EnterPlanMode', 'ExitPlanMode']));
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
      expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject({ disableAllHooks: true });
      expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual(['mcp__ordewell__task_complete', 'mcp__ordewell__checkpoint', 'mcp__ordewell__read', 'mcp__ordewell__run_command', 'mcp__ordewell__save_patch', 'mcp__ordewell__fetch', 'mcp__ordewell__web_search']);
      const events: AgentEvent[] = [];
      void adapter.send('Review', (e) => events.push(e));
      const requests: Array<[string, Record<string, unknown>, string]> = [
        ['Read', { file_path: '/task/a' }, 'allow'], ['Grep', { path: '/workspace' }, 'allow'],
        ['Glob', {}, 'allow'], ['LS', { path: '/outside' }, 'deny'],
        ['Write', { file_path: '/task/a', content: 'bad' }, 'deny'], ['Bash', { command: 'echo bad' }, 'deny'],
        ['WebFetch', { url: 'https://example.test' }, 'deny'], ['WebSearch', { query: 'docs' }, 'deny'],
        ['mcp__other__write', {}, 'deny'], ['mcp__ordewell__run_command', { command: 'npm test' }, 'allow'],
        ['mcp__ordewell__save_patch', {}, 'allow'],
        // Ordewell's web reads are its own tools, decided by the session's policy at the call (ADR-0046).
        ['mcp__ordewell__fetch', { url: 'https://example.test' }, 'allow'], ['mcp__ordewell__web_search', { query: 'docs' }, 'allow'],
        ['mcp__ordewellx__fetch', { url: 'https://example.test' }, 'deny'],
      ];
      const proc = spawned.processes[0];
      for (const [i, [tool_name, input, behavior]] of requests.entries()) {
        proc.emitStdout(`${JSON.stringify({ type: 'control_request', request_id: String(i), request: { subtype: 'can_use_tool', tool_name, input } })}\n`);
        await vi.waitFor(() => expect(proc.written.some((w) => w.includes(`"request_id":"${i}"`))).toBe(true));
        const response = proc.written.map((w) => JSON.parse(w) as { response?: { request_id: string; response: { behavior: string } } }).find((w) => w.response?.request_id === String(i));
        expect(response?.response?.response.behavior).toBe(behavior);
      }
      expect(events.filter((e) => e.type === 'permission_request').every((e) => e.decided)).toBe(true);
    } finally { adapter.dispose(); }
  });

  it('starts Codex without a sandbox probe or native shell, keeping discovery and declining changes', async () => {
    const { spawned, processDeps } = deps([fixture('codex', 'handshake'), codexAnswer('task-thread')]);
    const adapter = new CodexAdapter(processDeps);
    try {
      await adapter.start({ kind: 'task', cwd: '/task', model: 'chosen-model', mode: 'plan', flags: resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'plan' }), mcp });
      const proc = spawned.processes[0];
      const thread = proc.written.map((w) => JSON.parse(w) as { method?: string; params?: Record<string, unknown> }).find((w) => w.method === 'thread/start');
      expect(thread?.params).toMatchObject({ model: 'chosen-model', sandbox: 'read-only', approvalPolicy: 'never', config: { features: { shell_tool: false, unified_exec: false }, web_search: 'disabled' } });
      expect(thread?.params?.developerInstructions).toContain('ALL_TOOLS');
      expect(thread?.params?.developerInstructions).toContain('mcp__ordewell__run_command');
      expect(thread?.params?.developerInstructions).toContain('mcp__ordewell__save_patch');
      expect(thread?.params?.developerInstructions).toContain('`mcp__ordewell__fetch`');
      expect(thread?.params?.developerInstructions).toContain('Read web pages with `mcp__ordewell__fetch` and search with `mcp__ordewell__web_search`: your own web search is off on this task.');
      expect(spawned.probeArgs()).toEqual([]);
      const events: AgentEvent[] = [];
      void adapter.send('Review', (e) => events.push(e));
      for (const [i, method] of ['item/fileChange/requestApproval', 'item/commandExecution/requestApproval', 'item/permissions/requestApproval'].entries()) {
        proc.emitStdout(`${JSON.stringify({ jsonrpc: '2.0', id: 700 + i, method, params: {} })}\n`);
        await vi.waitFor(() => expect(proc.written.some((w) => w.includes(`"id":${700 + i}`))).toBe(true));
        const response = proc.written.map((w) => JSON.parse(w) as { id?: number; result?: unknown }).find((w) => w.id === 700 + i);
        expect(response?.result).toEqual(i === 2 ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
      }
      expect(events.filter((e) => e.type === 'permission_request').every((e) => e.decided?.decision === 'deny')).toBe(true);
    } finally { adapter.dispose(); }
  });

  it("keeps every MCP server of the user's Codex configuration from starting on a read-only task, as Claude and OpenCode deny theirs", async () => {
    const configured = { mcp_servers: { github: { url: 'https://example.test/mcp', default_tools_approval_mode: 'approve' }, notes: { command: 'notes-mcp' }, ordewell: { url: 'http://127.0.0.1:1/mcp' } } };
    const spawned = fakeSpawn([fixture('codex', 'handshake'), codexAnswer('task-thread')], {
      codexDiscovery: (method) => (method === 'config/read' ? { result: { config: configured, origins: {} } } : { data: [], nextCursor: null }),
    });
    const adapter = new CodexAdapter({ ...deps().processDeps, spawn: spawned.spawn });
    try {
      await adapter.start({ kind: 'task', cwd: '/task', mode: 'plan', flags: resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'plan' }), mcp });
      const written = spawned.processes[0].written.map((w) => JSON.parse(w) as { method?: string; params?: { cwd?: string; config?: { mcp_servers?: Record<string, Record<string, unknown>> } } });
      expect(written.find((w) => w.method === 'config/read')?.params).toEqual({ cwd: '/task' });
      const servers = written.find((w) => w.method === 'thread/start')?.params?.config?.mcp_servers;
      expect(servers).toMatchObject({ github: { enabled: false }, notes: { enabled: false }, ordewell: { url: mcp.url } });
      expect(servers?.ordewell.enabled).toBeUndefined();
    } finally { adapter.dispose(); }
  });

  it('does not start a read-only Codex task whose configured MCP servers it cannot learn', async () => {
    const spawned = fakeSpawn([fixture('codex', 'handshake'), codexAnswer('task-thread')], {
      codexDiscovery: (method) => (method === 'config/read' ? { error: { code: -32601, message: 'method not found' } } : { data: [], nextCursor: null }),
    });
    const adapter = new CodexAdapter({ ...deps().processDeps, spawn: spawned.spawn });
    try {
      await expect(adapter.start({ kind: 'task', cwd: '/task', mode: 'plan', flags: resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'plan' }), mcp })).rejects.toThrow(/read-only task cannot keep them off/);
      expect(spawned.processes[0].written.some((w) => w.includes('"thread/start"'))).toBe(false);
    } finally { adapter.dispose(); }
  });

  it('asks a change task\'s Codex nothing about its servers', async () => {
    const { spawned, processDeps } = deps([fixture('codex', 'handshake'), fixture('codex', 'task-thread')]);
    const adapter = new CodexAdapter({ ...processDeps, platform: 'darwin' });
    try {
      await adapter.start({ kind: 'task', cwd: '/task', mode: 'fullAccess', flags: resolveTaskRunnerFlags(CODEX_MANIFEST, { mode: 'fullAccess' }), mcp: mcpClientConfig({ token: 'test', url: 'http://127.0.0.1:4555/mcp' }) });
      expect(spawned.processes[0].written.some((w) => w.includes('"config/read"'))).toBe(false);
    } finally { adapter.dispose(); }
  });
});
