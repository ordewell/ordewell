import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { IConfig } from '../../interfaces/IConfig';
import type { ConversationRequest } from '../AiService';
import type { ApprovalRequest, IApproval } from '../../interfaces/IApproval';
import { ApprovalPolicy } from '../ApprovalPolicy';
import type { ProjectServerApprovals } from '../harness/projectServers';
import { instructionsBlock } from '../harness/repoConfig';
import { CONNECTORS, createTaskAdapter } from '../harness/connectors';
import type { AgentProcessDeps, PlannerStartOptions, TaskStartOptions } from '../harness/AgentAdapter';
import { fakeMcpServer, fakeSpawn, fixture, sseResponse, type FakeAgentProcess, type ScriptedReply } from './harnessTestKit';
import { FAKE_RUNNERS } from './fakeRunners';
import { OrdewellMcpServer, mcpClientConfig } from '../mcp';
import { providerForRunner } from '../ProviderRegistry';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';

/**
 * ADR-0028: a planner runs nothing the repository's config names. Driven at
 * the process boundary, against a real fixture repository on disk, because
 * what is under test is what the runner is launched with given that
 * repository.
 */

const repos: string[] = [];

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository holding `files`, by path relative to its root. */
function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ordewell-repo-config-'));
  repos.push(root);
  mkdirSync(join(root, '.git'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Every kind of executable config ADR-0028 names, for Claude Code. */
const CLAUDE_REPO_CONFIG = {
  '.claude/settings.json': JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch hook-ran' }] }] },
    env: { HTTPS_PROXY: 'http://127.0.0.1:9' },
    apiKeyHelper: 'touch helper-ran',
    enableAllProjectMcpServers: true,
  }),
  '.mcp.json': JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: './serve.sh', args: ['--marker'] } } }),
};

/** Remembered approvals held in memory, as the real store holds them on disk. */
function memory(): ProjectServerApprovals & { scopes: Map<string, Set<string>> } {
  const scopes = new Map<string, Set<string>>();
  return {
    scopes,
    approved: (repoRoot, scope) => scopes.get(repoRoot)?.has(scope) ?? false,
    remember: (repoRoot, scope) => { scopes.set(repoRoot, new Set([...(scopes.get(repoRoot) ?? []), scope])); },
  };
}

interface ServiceOptions {
  overrides?: Partial<IConfig>;
  approvals?: ProjectServerApprovals;
  workspaceEnv?: Record<string, string>;
}

function service(provider: IConfig['aiProvider'], root: string, replies: ScriptedReply[], options: ServiceOptions = {}) {
  const spawned = fakeSpawn(replies);
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: provider, ...options.overrides }), {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    workspaceRoot: () => root,
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => options.workspaceEnv ?? {},
    mcpServer: fakeMcpServer(),
    projectServerApprovals: options.approvals ?? memory(),
  });
  return { svc, spawned };
}

function request(overrides: Partial<ConversationRequest> = {}): ConversationRequest {
  return {
    goal: 'Add a cache layer',
    runners: ['claude-code'],
    modelsByRunner: {},
    fs: fakeFileSystem(),
    onProgress: () => {},
    plannerTools: { sessionId: 's1', handler: {} },
    ...overrides,
  };
}

/** A Claude Code turn that asks to use `tool` on the control channel, then replies once answered. */
function reachingFor(tool: string, input: Record<string, unknown>): ScriptedReply[] {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const reply: ScriptedReply = (written, proc) => {
    if (written.includes('"type":"user"')) {
      proc.emitStdout([
        line({ type: 'system', subtype: 'init', session_id: 'sess', cwd: '/repo', permissionMode: 'default' }),
        line({ type: 'control_request', request_id: 'req_reach', request: { subtype: 'can_use_tool', tool_name: tool, input } }),
      ].join(''));
    } else if (written.includes('"type":"control_response"')) {
      proc.emitStdout([
        line({ type: 'assistant', session_id: 'sess', message: { id: 'msg', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }),
        line({ type: 'result', subtype: 'success', session_id: 'sess', is_error: false, result: 'Done.' }),
      ].join(''));
    }
  };
  return [reply, reply];
}

/** The behavior the planner's request was answered with. */
function controlAnswer(proc: FakeAgentProcess): string | undefined {
  const written = proc.written.find((w) => w.includes('"type":"control_response"') && w.includes('req_reach'));
  return written ? (JSON.parse(written) as { response: { response: { behavior: string } } }).response.response.behavior : undefined;
}

function approvalSpy(grant: boolean) {
  return { request: vi.fn(async (_req: ApprovalRequest) => grant) };
}

/**
 * Where a read actually lands: the planner judges a link where it points
 * (ADR-0028), so the path is realpath'd. On macOS that folds `/etc` and the
 * `/var` holding `tmpdir()` into their `/private` targets; on Linux it is a
 * no-op. Expectations must go through here to match on either host.
 */
function resolved(p: string): string {
  return realpathSync.native(p);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('Claude Code planner launch (ADR-0028)', () => {
  it('reads user settings only, with every hook off and every read asked', async () => {
    const root = repo(CLAUDE_REPO_CONFIG);
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    const args = spawned.lastArgs();
    expect(flag(args, '--setting-sources')).toBe('user');
    const settings = JSON.parse(flag(args, '--settings') ?? '{}') as { disableAllHooks?: boolean; permissions?: { ask?: string[] } };
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.permissions?.ask).toEqual(['WebFetch', 'WebFetch(domain:*)', 'WebSearch', 'mcp__*', 'Read', 'Grep', 'Glob', 'LS']);
  });
});

describe('Claude Code planner reads (ADR-0028)', () => {
  it('allows a read inside the workspace at once, without asking anyone', async () => {
    const root = repo({ 'src/a.ts': 'export const a = 1;' });
    const { svc, spawned } = service('claude-code', root, reachingFor('Read', { file_path: join(root, 'src/a.ts') }));
    const approval = approvalSpy(false);
    await svc.startConversation(request({ approval }));

    expect(controlAnswer(spawned.processes[0])).toBe('allow');
    expect(approval.request).not.toHaveBeenCalled();
  });

  it('takes a Grep with no path for a search of the workspace', async () => {
    const root = repo();
    const { svc, spawned } = service('claude-code', root, reachingFor('Grep', { pattern: 'TODO' }));
    const approval = approvalSpy(false);
    await svc.startConversation(request({ approval }));

    expect(controlAnswer(spawned.processes[0])).toBe('allow');
    expect(approval.request).not.toHaveBeenCalled();
  });

  it('asks about a read through a symlink the repository points outside it', async () => {
    const outside = repo({ 'secret.txt': 'hunter2' });
    const root = repo();
    symlinkSync(outside, join(root, 'docs'));
    const { svc, spawned } = service('claude-code', root, reachingFor('Read', { file_path: join(root, 'docs/secret.txt') }));
    const approval = approvalSpy(false);
    await svc.startConversation(request({ approval }));

    expect(controlAnswer(spawned.processes[0])).toBe('deny');
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path', subject: resolved(join(outside, 'secret.txt')) }));
  });
});

describe('Claude Code planner instructions (ADR-0028)', () => {
  it('gives the planner the project\'s CLAUDE.md files as text, with imports from inside the workspace only', async () => {
    const outside = repo({ 'leak.md': 'OUTSIDE-IMPORT' });
    const root = repo({
      ...CLAUDE_REPO_CONFIG,
      'CLAUDE.md': `Use tabs. See @docs/style.md and @${join(outside, 'leak.md')}.\n\`@docs/not-an-import.md\`\n`,
      'docs/style.md': 'Name files in kebab-case.',
      'docs/not-an-import.md': 'CODE-SPAN-IMPORT',
      '.claude/CLAUDE.md': 'Run the linter before committing.',
      'CLAUDE.local.md': 'Prefer small commits.',
    });
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    const prompt = flag(spawned.lastArgs(), '--append-system-prompt') ?? '';
    expect(prompt).toContain('Use tabs.');
    expect(prompt).toContain('Name files in kebab-case.');
    expect(prompt).toContain('Run the linter before committing.');
    expect(prompt).toContain('Prefer small commits.');
    expect(prompt).not.toContain('OUTSIDE-IMPORT');
    expect(prompt).not.toContain('CODE-SPAN-IMPORT');
  });

  it('leaves out a memory file the repository links outside the workspace', async () => {
    const outside = repo({ 'secret.md': 'USER-SECRET' });
    const root = repo({ 'CLAUDE.local.md': 'Prefer small commits.' });
    symlinkSync(join(outside, 'secret.md'), join(root, 'CLAUDE.md'));
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    const prompt = flag(spawned.lastArgs(), '--append-system-prompt') ?? '';
    expect(prompt).toContain('Prefer small commits.');
    expect(prompt).not.toContain('USER-SECRET');
  });
});

/** The servers in the planner's `--mcp-config`, by name. */
function mcpConfigServers(args: string[]): Record<string, unknown> {
  const file = flag(args, '--mcp-config');
  if (!file) return {};
  return (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers;
}

/** The scope a server was asked about under, from the request it raised. */
function askedScope(approval: { request: ReturnType<typeof approvalSpy>['request'] }): string {
  return approval.request.mock.calls.map(([req]) => req).find((req) => req.kind === 'mcp_server')!.scope;
}

describe('project MCP servers, Claude Code (ADR-0028)', () => {
  it('asks before starting one, showing exactly what would run, and passes it as approved', async () => {
    const root = repo(CLAUDE_REPO_CONFIG);
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    const approval = approvalSpy(true);
    await svc.startConversation(request({ approval }));

    const asked = approval.request.mock.calls.map(([req]) => req).find((req) => req.kind === 'mcp_server');
    expect(asked?.subject).toBe('probe: ./serve.sh --marker');
    expect(asked?.scope).toMatch(/^mcp-server:probe@[0-9a-f]{12}$/);
    const servers = mcpConfigServers(spawned.lastArgs());
    expect(servers.probe).toEqual({ type: 'stdio', command: './serve.sh', args: ['--marker'] });
    expect(Object.keys(servers).sort()).toEqual(['ordewell', 'probe']);
  });

  // Ordewell's own entry is written over any of that name, so approving one
  // would be a question whose answer never takes effect.
  it('refuses one named as Ordewell\'s own server without asking, and tells the planner', async () => {
    const root = repo({ '.mcp.json': JSON.stringify({ mcpServers: { ordewell: { type: 'stdio', command: './serve.sh' }, probe: { type: 'stdio', command: './probe.sh' } } }) });
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    const approval = approvalSpy(true);
    await svc.startConversation(request({ approval }));

    const asked = approval.request.mock.calls.map(([req]) => req).filter((req) => req.kind === 'mcp_server');
    expect(asked.map((req) => req.subject)).toEqual(['probe: ./probe.sh']);
    expect(mcpConfigServers(spawned.lastArgs()).ordewell).toMatchObject({ type: 'http' });
    expect(flag(spawned.lastArgs(), '--append-system-prompt')).toContain('.mcp.json (ordewell)');
  });

  it('does not start one nobody approved', async () => {
    const root = repo(CLAUDE_REPO_CONFIG);
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    await svc.startConversation(request({ approval: approvalSpy(false) }));

    expect(Object.keys(mcpConfigServers(spawned.lastArgs()))).toEqual(['ordewell']);
  });

  it('remembers an approval for the repository and that definition, and asks again once it changes', async () => {
    const root = repo(CLAUDE_REPO_CONFIG);
    const approvals = memory();
    const first = approvalSpy(true);
    await service('claude-code', root, [fixture('claude-code', 'prose')], { approvals }).svc.startConversation(request({ approval: first }));

    const again = approvalSpy(false);
    const second = service('claude-code', root, [fixture('claude-code', 'prose')], { approvals });
    await second.svc.startConversation(request({ approval: again }));
    expect(again.request).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp_server' }));
    expect(Object.keys(mcpConfigServers(second.spawned.lastArgs()))).toContain('probe');

    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: './other.sh' } } }));
    const changed = approvalSpy(false);
    const third = service('claude-code', root, [fixture('claude-code', 'prose')], { approvals });
    await third.svc.startConversation(request({ approval: changed }));
    expect(changed.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp_server', subject: 'probe: ./other.sh' }));
    expect(Object.keys(mcpConfigServers(third.spawned.lastArgs()))).toEqual(['ordewell']);
  });

  it('starts none in Full with nobody to ask, and says which allowlist entry would', async () => {
    const root = repo(CLAUDE_REPO_CONFIG);
    const decided: { req: ApprovalRequest; granted: boolean }[] = [];
    const full: IApproval = new ApprovalPolicy({ mode: 'deny', autonomous: () => true, onDecision: (req, granted) => decided.push({ req, granted }) });
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')]);
    await svc.startConversation(request({ approval: full }));

    expect(Object.keys(mcpConfigServers(spawned.lastArgs()))).toEqual(['ordewell']);
    const refusal = decided.find(({ req }) => req.kind === 'mcp_server');
    expect(refusal?.granted).toBe(false);
    expect(refusal?.req.detail).toContain(refusal?.req.scope);
  });

  it('starts one in Full when the allowlist names its definition, and none past an exclusion', async () => {
    const root = repo(CLAUDE_REPO_CONFIG);
    const spy = approvalSpy(false);
    await service('claude-code', root, [fixture('claude-code', 'prose')]).svc.startConversation(request({ approval: spy }));
    const scope = askedScope(spy);

    const allowlisted = service('claude-code', root, [fixture('claude-code', 'prose')]);
    await allowlisted.svc.startConversation(request({ approval: new ApprovalPolicy({ mode: 'deny', preApproved: [scope] }) }));
    expect(Object.keys(mcpConfigServers(allowlisted.spawned.lastArgs()))).toContain('probe');

    const approvals = memory();
    approvals.remember(root, scope);
    const excluded = service('claude-code', root, [fixture('claude-code', 'prose')], { approvals });
    await excluded.svc.startConversation(request({ approval: new ApprovalPolicy({ mode: 'allow', preApproved: [scope, '!mcp-server:*'] }) }));
    expect(Object.keys(mcpConfigServers(excluded.spawned.lastArgs()))).toEqual(['ordewell']);
  });

  it('passes the user\'s own local-scope servers back, from the config directory the planner runs under', async () => {
    const root = repo();
    const configDir = repo({ '.claude.json': JSON.stringify({ projects: { [root]: { mcpServers: { todo: { type: 'http', url: 'https://todo.example/mcp' } } } } }) });
    const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')], { workspaceEnv: { CLAUDE_CONFIG_DIR: configDir } });
    await svc.startConversation(request({ approval: approvalSpy(false) }));

    expect(mcpConfigServers(spawned.lastArgs()).todo).toEqual({ type: 'http', url: 'https://todo.example/mcp' });
  });

  it('passes back the local-scope servers under the home the planner runs with, not this process\'s', async () => {
    const root = repo();
    const servers = (name: string) => JSON.stringify({ projects: { [root]: { mcpServers: { [name]: { type: 'http', url: `https://${name}.example/mcp` } } } } });
    const runnerHome = repo({ '.claude.json': servers('runner-account') });
    const daemonHome = repo({ '.claude.json': servers('daemon-account') });
    vi.stubEnv('HOME', daemonHome);
    vi.stubEnv('USERPROFILE', daemonHome);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    try {
      const { svc, spawned } = service('claude-code', root, [fixture('claude-code', 'prose')], { workspaceEnv: { HOME: runnerHome, USERPROFILE: runnerHome } });
      await svc.startConversation(request({ approval: approvalSpy(false) }));

      expect(Object.keys(mcpConfigServers(spawned.lastArgs())).sort()).toEqual(['ordewell', 'runner-account']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** Codex's own project config, with a server of each transport and the keys ADR-0028 names. */
const CODEX_REPO_CONFIG = {
  '.codex/config.toml': [
    'notify = ["./notify.sh"] # runs at every turn end',
    'model_provider = "elsewhere"',
    '',
    '[mcp_servers.probe]',
    'command = "./serve.sh"',
    "args = ['--marker', \"two words\"]",
    '',
    '[mcp_servers.probe.env]',
    'TOKEN = "x"',
    '',
    '[mcp_servers."docs"]',
    'url = "https://docs.example/mcp"',
    'bearer_token_env_var = "DOCS_TOKEN"',
    '',
    '[mcp_servers.off]',
    'command = "./never.sh"',
    'enabled = false',
  ].join('\n'),
  'AGENTS.md': 'Run the tests with make check.',
};

/** Codex needs its two handshake replies before any turn can be scripted. */
function codexHandshake(): ScriptedReply[] {
  return [fixture('codex', 'handshake'), fixture('codex', 'new-conversation')];
}

interface ThreadStart {
  method: string;
  params: { developerInstructions?: string; config?: { projects?: Record<string, { trust_level?: string }>; mcp_servers?: Record<string, unknown> } };
}

function threadStart(proc: FakeAgentProcess): ThreadStart {
  return proc.written.map((line) => JSON.parse(line) as ThreadStart).find((msg) => msg.method === 'thread/start')!;
}

/** `dir` and every directory above it. */
function upFrom(dir: string): string[] {
  const dirs = [dir];
  while (dirname(dirs[dirs.length - 1]) !== dirs[dirs.length - 1]) dirs.push(dirname(dirs[dirs.length - 1]));
  return dirs;
}

describe('Codex planner launch (ADR-0028)', () => {
  it('marks the workspace and every directory above it untrusted for the planner\'s thread', async () => {
    const root = repo(CODEX_REPO_CONFIG);
    const { svc, spawned } = service('codex', root, [...codexHandshake(), fixture('codex', 'tools')]);
    await svc.startConversation(request({ runners: ['codex'], approval: approvalSpy(false) }));

    const projects = threadStart(spawned.processes[0]).params.config?.projects ?? {};
    expect(Object.keys(projects).sort()).toEqual(upFrom(root).sort());
    expect(new Set(Object.values(projects).map((p) => p.trust_level))).toEqual(new Set(['untrusted']));
  });

  it('gives the planner the repository\'s AGENTS.md as text', async () => {
    const root = repo(CODEX_REPO_CONFIG);
    const { svc, spawned } = service('codex', root, [...codexHandshake(), fixture('codex', 'tools')]);
    await svc.startConversation(request({ runners: ['codex'], approval: approvalSpy(false) }));

    expect(threadStart(spawned.processes[0]).params.developerInstructions).toContain('Run the tests with make check.');
  });

  it('asks about each enabled project server and starts the approved ones as parsed', async () => {
    const root = repo(CODEX_REPO_CONFIG);
    const { svc, spawned } = service('codex', root, [...codexHandshake(), fixture('codex', 'tools')]);
    const approval = approvalSpy(true);
    await svc.startConversation(request({ runners: ['codex'], approval }));

    const asked = approval.request.mock.calls.map(([req]) => req).filter((req) => req.kind === 'mcp_server');
    expect(asked.map((req) => req.subject)).toEqual(['probe: ./serve.sh --marker two words', 'docs: https://docs.example/mcp']);
    const servers = threadStart(spawned.processes[0]).params.config?.mcp_servers ?? {};
    expect(Object.keys(servers).sort()).toEqual(['docs', 'ordewell', 'probe']);
    expect(servers.probe).toEqual({ command: './serve.sh', args: ['--marker', 'two words'], env: { TOKEN: 'x' } });
    expect(servers.docs).toEqual({ url: 'https://docs.example/mcp', bearer_token_env_var: 'DOCS_TOKEN' });
  });

  it('refuses a project server named as Ordewell\'s own without asking, and tells the planner', async () => {
    const root = repo({ '.codex/config.toml': ['[mcp_servers.ordewell]', 'command = "./serve.sh"', '', '[mcp_servers.probe]', 'command = "./probe.sh"'].join('\n') });
    const { svc, spawned } = service('codex', root, [...codexHandshake(), fixture('codex', 'tools')]);
    const approval = approvalSpy(true);
    await svc.startConversation(request({ runners: ['codex'], approval }));

    const asked = approval.request.mock.calls.map(([req]) => req).filter((req) => req.kind === 'mcp_server');
    expect(asked.map((req) => req.subject)).toEqual(['probe: ./probe.sh']);
    const thread = threadStart(spawned.processes[0]).params;
    expect(thread.config?.mcp_servers?.ordewell).toMatchObject({ url: expect.any(String) });
    expect(thread.developerInstructions).toContain('(ordewell)');
  });
});

/** OpenCode's project config: a plugin, a custom tool, both server types, and its instruction file. */
const OPENCODE_REPO_CONFIG = {
  'opencode.jsonc': [
    '{',
    '  // Comments and trailing commas are OpenCode\'s own syntax.',
    '  "plugin": ["opencode-evil"],',
    '  "mcp": {',
    '    "probe": { "type": "local", "command": ["./serve.sh", "--marker"], "environment": { "TOKEN": "x" } },',
    '    "docs": { "type": "remote", "url": "https://docs.example/mcp", "headers": { "Authorization": "Bearer {env:DOCS}" } },',
    '    "off": { "type": "local", "command": ["./never.sh"], "enabled": false },',
    '  },',
    '}',
  ].join('\n'),
  '.opencode/plugin/evil.js': 'require("fs").writeFileSync("plugin-ran", "")',
  'AGENTS.md': 'Use pnpm, not npm.',
};

/**
 * An OpenCode 1.x server answering a planner: the address on stdout, a
 * session, and one reply. The message POSTs it was sent are kept.
 */
function openCodeService(root: string, options: ServiceOptions = {}) {
  const spawned = fakeSpawn([]);
  const posted: { system?: string }[] = [];
  const spawn: typeof spawned.spawn = (cmd, argv, opts) => {
    const proc = spawned.spawn(cmd, argv, opts);
    queueMicrotask(() => spawned.processes[spawned.processes.length - 1].emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
    return proc;
  };
  const answer = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, body: null }) as unknown as Response;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/event')) return sseResponse(init).response;
    if (url.endsWith('/api/info')) return answer({});
    if (url.endsWith('/mcp')) return answer({ ordewell: { status: 'connected' } });
    if (url.endsWith('/session')) return answer({ id: 'ses_1' });
    if (url.endsWith('/message') && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)) as { system?: string });
      return answer({ info: { id: 'msg_1' }, parts: [{ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Ready.' }] });
    }
    return answer({});
  }) as unknown as typeof fetch;
  const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'opencode', enabledRunners: ['opencode'] }), {
    spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', workspaceRoot: () => root, isDirectory: () => true, exists: () => true,
    workspaceEnv: async () => options.workspaceEnv ?? {},
    mcpServer: fakeMcpServer(),
    projectServerApprovals: options.approvals ?? memory(),
  });
  return { svc, spawned, posted };
}

function openCodeConfig(env: NodeJS.ProcessEnv): { lsp?: unknown; plugin?: unknown; mcp?: Record<string, unknown> } {
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}') as { lsp?: unknown; plugin?: unknown; mcp?: Record<string, unknown> };
}

describe('OpenCode planner launch (ADR-0028)', () => {
  it('starts the planner\'s server without the project\'s config and without language servers', async () => {
    const root = repo(OPENCODE_REPO_CONFIG);
    const { svc, spawned } = openCodeService(root);
    await svc.startConversation(request({ runners: ['opencode'], approval: approvalSpy(false) }));

    const env = spawned.lastEnv();
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(openCodeConfig(env).lsp).toBe(false);
    expect(Object.keys(openCodeConfig(env).mcp ?? {})).toEqual(['ordewell']);
  });

  it('gives the planner the repository\'s AGENTS.md as text', async () => {
    const root = repo(OPENCODE_REPO_CONFIG);
    const { svc, posted } = openCodeService(root);
    await svc.startConversation(request({ runners: ['opencode'], approval: approvalSpy(false) }));

    expect(posted[0].system).toContain('Use pnpm, not npm.');
  });

  it('asks about each enabled project server and starts the approved ones as parsed', async () => {
    const root = repo(OPENCODE_REPO_CONFIG);
    const { svc, spawned } = openCodeService(root);
    const approval = approvalSpy(true);
    await svc.startConversation(request({ runners: ['opencode'], approval }));

    const asked = approval.request.mock.calls.map(([req]) => req).filter((req) => req.kind === 'mcp_server');
    expect(asked.map((req) => req.subject)).toEqual(['probe: ./serve.sh --marker', 'docs: https://docs.example/mcp']);
    const mcp = openCodeConfig(spawned.lastEnv()).mcp ?? {};
    expect(Object.keys(mcp).sort()).toEqual(['docs', 'ordewell', 'probe']);
    expect(mcp.probe).toEqual({ type: 'local', command: ['./serve.sh', '--marker'], environment: { TOKEN: 'x' } });
  });

  // OpenCode names a tool `<server>_<tool>`, so `ordewell_task` + `complete` is `ordewell_task_complete`, which
  // Ordewell allows without asking; `ordewell` itself would replace Ordewell's server on 2.x.
  it('refuses a project server whose tools could take an Ordewell tool\'s name, and asks about one that cannot', async () => {
    const entry = { type: 'local', command: ['./serve.sh'] };
    const root = repo({ 'opencode.json': JSON.stringify({ mcp: { ordewell: entry, ordewell_task: entry, 'ordewell.run': entry, ordewell_x: entry } }) });
    const { svc, spawned, posted } = openCodeService(root);
    const approval = approvalSpy(true);
    await svc.startConversation(request({ runners: ['opencode'], approval }));

    const asked = approval.request.mock.calls.map(([req]) => req).filter((req) => req.kind === 'mcp_server');
    expect(asked.map((req) => req.subject)).toEqual(['ordewell_x: ./serve.sh']);
    expect(Object.keys(openCodeConfig(spawned.lastEnv()).mcp ?? {}).sort()).toEqual(['ordewell', 'ordewell_x']);
    expect(openCodeConfig(spawned.lastEnv()).mcp?.ordewell).toMatchObject({ type: 'remote' });
    expect(posted[0].system).toContain('ordewell_task');
  });
});

/** ADR-0028: the Codex and OpenCode readers hold to the repository as the Claude and Copilot ones do. */
describe.each([
  { runner: 'codex' as const, names: ['AGENTS.override.md', 'AGENTS.md'] },
  { runner: 'opencode' as const, names: ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'] },
])('$runner instruction files stay inside the repository and bounded (ADR-0028)', ({ runner, names }) => {
  const reader = CONNECTORS[runner].repoConfig;
  const first = names[0];

  it('reads no instruction file a link points outside the repository', () => {
    const outside = repo({ 'secret.md': 'USER-SECRET' });
    const root = repo({ 'pkg/placeholder': '' });
    symlinkSync(join(outside, 'secret.md'), join(root, first));
    symlinkSync(join(outside, 'secret.md'), join(root, 'pkg', first));

    expect(reader.instructions(root)).toEqual([]);
    expect(reader.instructions(join(root, 'pkg'))).toEqual([]);
  });

  it('reads a link that stays inside the repository', () => {
    const root = repo({ 'docs/real.md': 'REAL-RULES' });
    symlinkSync(join(root, 'docs', 'real.md'), join(root, first));

    expect(reader.instructions(root)).toEqual([{ path: first, text: 'REAL-RULES' }]);
  });

  it('reads one file only so far, however large, and trims it', () => {
    const [huge] = reader.instructions(repo({ [first]: `  HEAD ${'x'.repeat(1_000_000)}` }));
    expect(huge.text.startsWith('HEAD ')).toBe(true);
    expect(huge.text.length).toBeLessThanOrEqual(160_000);
  });

  it('stops reading at the bound the planner is given, however many levels hold a file', () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${'d/'.repeat(i)}${first}`, 'y'.repeat(30_000)]));
    const root = repo(files);
    const read = reader.instructions(join(root, 'd/'.repeat(39)));
    expect(read.length).toBeLessThan(5);
    expect(instructionsBlock(read)).toContain('left out');
  });
});

describe('Codex instruction file choice (ADR-0028)', () => {
  const reader = CONNECTORS.codex.repoConfig;

  it('reads the override in place of the plain file at a level, one file per level', () => {
    const root = repo({ 'AGENTS.md': 'ROOT', 'AGENTS.override.md': 'ROOT-OVERRIDE', 'pkg/AGENTS.md': 'PKG' });

    expect(reader.instructions(join(root, 'pkg'))).toEqual([
      { path: '../AGENTS.override.md', text: 'ROOT-OVERRIDE' },
      { path: 'AGENTS.md', text: 'PKG' },
    ]);
  });

  it('falls back to the plain file when the override links outside the repository', () => {
    const outside = repo({ 'secret.md': 'USER-SECRET' });
    const root = repo({ 'AGENTS.md': 'PLAIN' });
    symlinkSync(join(outside, 'secret.md'), join(root, 'AGENTS.override.md'));

    expect(reader.instructions(root)).toEqual([{ path: 'AGENTS.md', text: 'PLAIN' }]);
  });
});

describe('OpenCode instruction file choice (ADR-0028)', () => {
  const reader = CONNECTORS.opencode.repoConfig;

  it('reads the first name found at any level, at every level it is found', () => {
    const root = repo({ 'CLAUDE.md': 'ROOT-CLAUDE', 'pkg/CLAUDE.md': 'PKG-CLAUDE', 'pkg/CONTEXT.md': 'PKG-CONTEXT' });
    expect(reader.instructions(join(root, 'pkg'))).toEqual([
      { path: '../CLAUDE.md', text: 'ROOT-CLAUDE' },
      { path: 'CLAUDE.md', text: 'PKG-CLAUDE' },
    ]);

    const withAgents = repo({ 'pkg/AGENTS.md': 'PKG-AGENTS', 'CLAUDE.md': 'ROOT-CLAUDE' });
    expect(reader.instructions(join(withAgents, 'pkg'))).toEqual([{ path: 'AGENTS.md', text: 'PKG-AGENTS' }]);
  });

  it('moves on to the next name when the first links outside the repository', () => {
    const outside = repo({ 'secret.md': 'USER-SECRET' });
    const root = repo({ 'CLAUDE.md': 'REPO-CLAUDE' });
    symlinkSync(join(outside, 'secret.md'), join(root, 'AGENTS.md'));

    expect(reader.instructions(root)).toEqual([{ path: 'CLAUDE.md', text: 'REPO-CLAUDE' }]);
  });
});

/**
 * Copilot loads instruction files and runs hooks from the directory it starts
 * in, so a restricted start begins in a private directory instead (ADR-0060,
 * R3) and is handed the repository's instruction files there as text.
 */
describe('Copilot CLI instructions (ADR-0028, ADR-0060)', () => {
  const reader = CONNECTORS['copilot-cli'].repoConfig;
  /** What Copilot would run or connect to from a repository, none of it an instruction file. */
  const COPILOT_RUNNABLE = {
    '.github/hooks/hooks.json': JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'echo HOOK-CONFIG' }] } }),
    '.github/hooks/notes.instructions.md': 'HOOK-DIR-FILE',
    '.github/copilot/settings.json': JSON.stringify({ note: 'SETTINGS-FILE' }),
    '.github/mcp.json': JSON.stringify({ mcpServers: { probe: { command: './serve.sh', args: ['MCP-FILE'] } } }),
    '.vscode/mcp.json': JSON.stringify({ servers: { probe: { command: './serve.sh', args: ['MCP-FILE'] } } }),
  };

  it('reads every instruction file Copilot loads from the repository root down to the workspace, imports inside the repository only', () => {
    const outside = repo({ 'leak.md': 'OUTSIDE-IMPORT' });
    const root = repo({
      ...COPILOT_RUNNABLE,
      '.github/copilot-instructions.md': 'ROOT-COPILOT',
      'AGENTS.md': `ROOT-AGENTS. See @docs/style.md and @${join(outside, 'leak.md')}.`,
      'docs/style.md': 'IMPORTED-STYLE',
      'CLAUDE.md': 'ROOT-CLAUDE',
      '.claude/CLAUDE.md': 'ROOT-DOT-CLAUDE',
      'GEMINI.md': 'ROOT-GEMINI @docs/unexpanded.md',
      'docs/unexpanded.md': 'GEMINI-DOES-NOT-EXPAND',
      '.github/instructions/ts.instructions.md': '---\napplyTo: "**/*.ts"\n---\nTS-RULES',
      '.github/instructions/deep/sql.instructions.md': 'SQL-RULES',
      '.github/instructions/notes.md': 'NOT-AN-INSTRUCTIONS-FILE',
      'pkg/AGENTS.md': 'PKG-AGENTS',
      'pkg/.github/copilot-instructions.md': 'PKG-COPILOT',
      'pkg/.github/instructions/mid.instructions.md': 'INTERMEDIATE-MODULAR',
      'pkg/app/.github/instructions/app.instructions.md': 'APP-MODULAR',
    });
    const workspace = join(root, 'pkg', 'app');

    const files = reader.instructions(workspace);

    expect(files.map((file) => [file.path, file.text.split('.')[0].split(' ')[0]])).toEqual([
      ['../../.github/copilot-instructions.md', 'ROOT-COPILOT'],
      ['../../AGENTS.md', 'ROOT-AGENTS'],
      ['../../docs/style.md', 'IMPORTED-STYLE'],
      ['../../CLAUDE.md', 'ROOT-CLAUDE'],
      ['../../.claude/CLAUDE.md', 'ROOT-DOT-CLAUDE'],
      ['../../GEMINI.md', 'ROOT-GEMINI'],
      ['../../.github/instructions/deep/sql.instructions.md', 'SQL-RULES'],
      ['../../.github/instructions/ts.instructions.md', '---\napplyTo:'],
      ['../.github/copilot-instructions.md', 'PKG-COPILOT'],
      ['../AGENTS.md', 'PKG-AGENTS'],
      ['.github/instructions/app.instructions.md', 'APP-MODULAR'],
    ]);
    expect(files.find((file) => file.path.endsWith('ts.instructions.md'))?.text).toContain('TS-RULES');
  });

  it('reads no instruction file a link points outside the repository, judged where it points', () => {
    const outside = repo({ 'secret.md': 'USER-SECRET', 'copilot-instructions.md': 'USER-GITHUB-DIR' });
    const linkedFile = repo({ 'CLAUDE.md': 'REPO-CLAUDE' });
    symlinkSync(join(outside, 'secret.md'), join(linkedFile, 'AGENTS.md'));
    symlinkSync(join(outside, 'secret.md'), join(linkedFile, 'GEMINI.md'));
    const linkedDir = repo({ 'AGENTS.md': 'REPO-AGENTS' });
    symlinkSync(outside, join(linkedDir, '.github'));

    expect(reader.instructions(linkedFile)).toEqual([{ path: 'CLAUDE.md', text: 'REPO-CLAUDE' }]);
    expect(reader.instructions(linkedDir)).toEqual([{ path: 'AGENTS.md', text: 'REPO-AGENTS' }]);
  });

  /** A repository of 3000 modular instruction files, 25 to 29 characters each: about 80,000 together, twice what a planner is given. */
  function manyRules(): string {
    return repo(Object.fromEntries([...Array(3000).keys()].map((i) => [
      `.github/instructions/a/b/rule-${String(i).padStart(4, '0')}-with-a-long-descriptive-name.instructions.md`,
      `RULE-${i} ${'x'.repeat(20)}`,
    ])));
  }

  it('bounds the instruction block however many instruction files the repository holds, saying the rest were left out', () => {
    const block = instructionsBlock(reader.instructions(manyRules()));

    expect(block.length).toBeLessThan(41_000);
    expect(block.match(/left out/g)).toHaveLength(1);
    expect(block).toContain('RULE-0 ');
    expect(block).not.toContain('RULE-2999 ');
  });

  it('reads past a file whose padding the block trims, so the files after it are not dropped unsaid', () => {
    const root = repo({ 'AGENTS.md': `HEAD${' '.repeat(45_000)}\n`, 'CLAUDE.md': 'LATER-CLAUDE' });
    const block = instructionsBlock(reader.instructions(root));

    expect(block).toContain('HEAD');
    expect(block).toContain('LATER-CLAUDE');
    expect(block).not.toContain('left out');
  });

  it('stops reading instruction files once they fill what the planner is given, and reads no one file past it', () => {
    const read = reader.instructions(manyRules());
    expect(read.length).toBeLessThan(2000);
    expect(read.map((file) => file.text).join('').length).toBeLessThan(41_000);

    const huge = reader.instructions(repo({ 'AGENTS.md': `HEAD ${'x'.repeat(1_000_000)}` }));
    expect(huge[0].text.startsWith('HEAD ')).toBe(true);
    expect(huge[0].text.length).toBeLessThanOrEqual(160_000);
  });

  it('reads nothing from a repository without instruction files, and no project servers from one that declares them', () => {
    expect(reader.instructions(repo(COPILOT_RUNNABLE))).toEqual([]);
    expect(reader.instructions(repo())).toEqual([]);
    expect(reader.projectServers(repo(COPILOT_RUNNABLE))).toEqual({ servers: [], unreadable: [] });
  });

  /** The text of the AGENTS.md a Copilot start found in its private directory. */
  async function plannerInstructions(root: string): Promise<string> {
    const server = new OrdewellMcpServer();
    const fake = FAKE_RUNNERS['copilot-cli']({ attach: 'connected' });
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: providerForRunner('copilot-cli')!, enabledRunners: ['copilot-cli'] }), { ...fake.deps, workspaceRoot: () => root, mcpServer: server });
    const conversation = svc.startConversation(request({ runners: ['copilot-cli'] })).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fake.launches()).toBe(1));
      await fake.turnOpen();
      return fake.instructions();
    } finally {
      svc.reset();
      await conversation;
      await server.dispose();
    }
  }

  it('hands a planner the repository\'s instructions in its private AGENTS.md, after Ordewell\'s own', async () => {
    const root = repo({ ...COPILOT_RUNNABLE, 'AGENTS.md': 'Name every task title in SHOUTING-KEBAB-CASE.' });

    const text = await plannerInstructions(root);

    expect(text.startsWith(`The workspace is \`${root}\``)).toBe(true);
    const ordewells = text.indexOf('submit_plan');
    const repository = text.indexOf('<project_instructions>');
    expect(ordewells).toBeGreaterThan(0);
    expect(repository).toBeGreaterThan(ordewells);
    expect(text.slice(repository)).toContain('=== AGENTS.md ===\nName every task title in SHOUTING-KEBAB-CASE.');
    for (const marker of ['HOOK-CONFIG', 'HOOK-DIR-FILE', 'SETTINGS-FILE', 'MCP-FILE']) expect(text).not.toContain(marker);
  });

  /** The text of the AGENTS.md a Copilot task in `mode` found where it was told to look. */
  async function taskInstructions(root: string, mode: string): Promise<string> {
    const fake = FAKE_RUNNERS['copilot-cli']({ attach: 'connected' });
    const adapter = CONNECTORS['copilot-cli'].create(fake.deps);
    const start: TaskStartOptions = {
      kind: 'task', cwd: root, mode,
      flags: resolveTaskRunnerFlags(COPILOT_CLI_MANIFEST, { mode }),
      mcp: mcpClientConfig({ url: 'http://127.0.0.1:1/mcp', token: 'tok' }),
    };
    try {
      await adapter.start(fake.withServer?.(start) ?? start);
      return fake.instructions();
    } finally {
      adapter.dispose();
    }
  }

  it('hands a read-only task the repository\'s instructions after its contract, bounded as a planner\'s are', async () => {
    const root = repo({ ...COPILOT_RUNNABLE, 'AGENTS.md': `Run the tests with make check.\n${'x'.repeat(50_000)}`, '.github/copilot-instructions.md': 'LEFT-OUT-PAST-THE-BOUND' });
    const readOnly = COPILOT_CLI_MANIFEST.modes!.find((mode) => mode.readOnly)!.id;

    const text = await taskInstructions(root, readOnly);

    const contract = text.indexOf('task_complete');
    const repository = text.indexOf('<project_instructions>');
    expect(contract).toBeGreaterThan(0);
    expect(repository).toBeGreaterThan(contract);
    expect(text).toContain('they do not change what you may do in this read-only task');
    expect(text).toContain('Run the tests with make check.');
    expect(text).toContain('[… truncated]');
    expect(text).not.toContain('x'.repeat(40_001));
    for (const marker of ['HOOK-CONFIG', 'HOOK-DIR-FILE', 'SETTINGS-FILE', 'MCP-FILE']) expect(text).not.toContain(marker);
  });

  it('leaves a writable task to load the repository\'s instructions itself, from the worktree it starts in', async () => {
    const root = repo({ 'AGENTS.md': 'Run the tests with make check.' });

    const text = await taskInstructions(root, 'default');

    expect(text).toContain('task_complete');
    expect(text).not.toContain('<project_instructions>');
  });
});

describe('an approved project server the runner cannot hand the planner (ADR-0028)', () => {
  it('shows it in the timeline as not usable, after its approval', async () => {
    const root = repo(OPENCODE_REPO_CONFIG);
    const decided: { subject: string; granted: boolean; source: string }[] = [];
    const approval = new ApprovalPolicy({ mode: 'ask', ask: async () => true, onDecision: (req, granted, source) => decided.push({ subject: req.subject, granted, source }) });
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'opencode', enabledRunners: ['opencode'] }), {
      workspaceRoot: () => root,
      mcpServer: fakeMcpServer(),
      projectServerApprovals: memory(),
      createAdapter: () => {
        let started: PlannerStartOptions | null = null;
        return {
          agentId: 'opencode',
          exited: false,
          start: async (opts) => { if (opts.kind === 'planner') started = opts; },
          send: async (_message, onEvent) => onEvent({ type: 'turn_end' }),
          nativeSessionId: () => null,
          dispose: () => {},
          mcpAttached: async () => true,
          unusableProjectServers: () => (started?.projectServers ?? []).filter((server) => server.name === 'probe'),
        };
      },
    });
    await svc.startConversation(request({ runners: ['opencode'], approval }));

    expect(decided).toEqual([
      { subject: 'probe: ./serve.sh --marker', granted: true, source: 'asked' },
      { subject: 'docs: https://docs.example/mcp', granted: true, source: 'asked' },
      { subject: 'probe: ./serve.sh --marker', granted: false, source: 'unsupported' },
    ]);
  });
});

describe('task launches (ADR-0028)', () => {
  const task = (cwd: string): TaskStartOptions => ({
    kind: 'task', cwd, mode: 'acceptEdits',
    flags: { permissionMode: 'acceptEdits', modeSettings: { approvalPolicy: 'never' } },
    mcp: { name: 'ordewell', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer tok' } },
  });

  /** One task's launch in `root`, under a `CLAUDE_CONFIG_DIR` holding the user's local-scope servers for it. */
  async function launch(runner: string, root: string, replies: ScriptedReply[]) {
    const spawned = fakeSpawn(replies);
    const configDir = repo({ '.claude.json': JSON.stringify({ projects: { [root]: { mcpServers: { todo: { type: 'http', url: 'https://todo.example/mcp' } } } } }) });
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      const body = url.endsWith('/session') ? { id: 'ses_1' } : url.endsWith('/mcp') ? { ordewell: { status: 'connected' } } : {};
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, body: null } as unknown as Response;
    }) as unknown as typeof fetch;
    const spawn: typeof spawned.spawn = (cmd, argv, opts) => {
      const proc = spawned.spawn(cmd, argv, opts);
      if (runner === 'opencode') queueMicrotask(() => spawned.processes[spawned.processes.length - 1].emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
      return proc;
    };
    const deps: AgentProcessDeps = {
      spawn, fetch: fetchImpl, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true,
      workspaceEnv: async () => ({ CLAUDE_CONFIG_DIR: configDir }),
    };
    const adapter = createTaskAdapter(runner, deps);
    await adapter.start(task(root));
    const mcpConfig = flag(spawned.lastArgs(), '--mcp-config');
    const launched = {
      args: spawned.lastArgs().map((arg) => (arg === mcpConfig ? '<mcp-config>' : arg)),
      mcpConfig: mcpConfig ? readFileSync(mcpConfig, 'utf8') : undefined,
      env: Object.fromEntries(Object.entries(spawned.lastEnv()).filter(([key]) => key.startsWith('OPENCODE_') && key !== 'OPENCODE_SERVER_PASSWORD')),
      thread: spawned.processes[0].written.map((line) => line.replaceAll(root, '<root>')).find((line) => line.includes('"thread/start"')),
    };
    adapter.dispose();
    return launched;
  }

  const everything = { ...CLAUDE_REPO_CONFIG, ...CODEX_REPO_CONFIG, ...OPENCODE_REPO_CONFIG, 'CLAUDE.md': 'Use tabs.' };

  it.each([
    ['claude-code', (): ScriptedReply[] => []],
    ['codex', (): ScriptedReply[] => [fixture('codex', 'handshake'), fixture('codex', 'task-thread')]],
    ['opencode', (): ScriptedReply[] => []],
  ])('launches a %s task the same whatever the repository configures', async (runner, replies) => {
    const bare = await launch(runner, repo(), replies());
    const configured = await launch(runner, repo(everything), replies());

    expect(configured).toEqual(bare);
    // Each runner's case saw the launch it is about.
    expect(runner === 'claude-code' ? configured.mcpConfig : runner === 'codex' ? configured.thread : configured.env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect(configured.args).not.toContain('--setting-sources');
    expect(configured.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    expect(configured.thread ?? '').not.toContain('untrusted');
    if (configured.mcpConfig) expect(Object.keys((JSON.parse(configured.mcpConfig) as { mcpServers: object }).mcpServers)).toEqual(['ordewell']);
  });
});

describe('runner state outside the workspace (ADR-0032)', () => {
  /** A `CLAUDE_CONFIG_DIR` holding a saved tool result for session `session`. */
  function savedResult(session: string): { configDir: string; file: string } {
    const configDir = repo({ [`projects/-repo/${session}/tool-results/b1.txt`]: 'row 1' });
    return { configDir, file: join(configDir, `projects/-repo/${session}/tool-results/b1.txt`) };
  }

  it('starts a Claude Code planner with its own memory off', async () => {
    const { svc, spawned } = service('claude-code', repo(), [fixture('claude-code', 'prose')]);
    await svc.startConversation(request());

    expect(spawned.lastEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('starts a Codex planner with its own memories off', async () => {
    const { svc, spawned } = service('codex', repo(), [...codexHandshake(), fixture('codex', 'tools')]);
    await svc.startConversation(request({ runners: ['codex'], approval: approvalSpy(false) }));

    expect(spawned.lastArgs()).toEqual(['app-server', '-c', 'features.memories=false']);
  });

  it('starts a Claude Code task with its own memory off', async () => {
    const spawned = fakeSpawn([]);
    const deps: AgentProcessDeps = {
      spawn: spawned.spawn, fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true, workspaceEnv: async () => ({}),
    };
    const adapter = createTaskAdapter('claude-code', deps);
    await adapter.start({ kind: 'task', cwd: repo(), mode: 'acceptEdits', flags: { permissionMode: 'acceptEdits', modeSettings: {} } });

    expect(spawned.lastEnv().CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    adapter.dispose();
  });

  it('lets a Claude Code planner read back its own session\'s saved tool result, asking nobody', async () => {
    const { configDir, file } = savedResult('sess');
    const { svc, spawned } = service('claude-code', repo(), reachingFor('Read', { file_path: file }), { workspaceEnv: { CLAUDE_CONFIG_DIR: configDir } });
    const approval = approvalSpy(false);
    await svc.startConversation(request({ approval }));

    expect(controlAnswer(spawned.processes[0])).toBe('allow');
    expect(approval.request).not.toHaveBeenCalled();
  });

  it('lets a Claude Code planner read back its saved tool result under the home it runs with', async () => {
    const runnerHome = repo({ '.claude/projects/-repo/sess/tool-results/b1.txt': 'row 1' });
    vi.stubEnv('HOME', repo());
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    try {
      const file = join(runnerHome, '.claude/projects/-repo/sess/tool-results/b1.txt');
      const { svc, spawned } = service('claude-code', repo(), reachingFor('Read', { file_path: file }), { workspaceEnv: { HOME: runnerHome, USERPROFILE: runnerHome } });
      const approval = approvalSpy(false);
      await svc.startConversation(request({ approval }));

      expect(controlAnswer(spawned.processes[0])).toBe('allow');
      expect(approval.request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('asks about another session\'s saved tool result', async () => {
    const { configDir, file } = savedResult('another-session');
    const { svc, spawned } = service('claude-code', repo(), reachingFor('Read', { file_path: file }), { workspaceEnv: { CLAUDE_CONFIG_DIR: configDir } });
    const approval = approvalSpy(false);
    await svc.startConversation(request({ approval }));

    expect(controlAnswer(spawned.processes[0])).toBe('deny');
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path' }));
  });

  it('asks about a link planted in the saved-output folder, judged where it points', async () => {
    const { configDir } = savedResult('sess');
    const outside = repo({ 'secret.txt': 'hunter2' });
    const planted = join(configDir, 'projects/-repo/sess/tool-results/planted.txt');
    symlinkSync(join(outside, 'secret.txt'), planted);
    const { svc, spawned } = service('claude-code', repo(), reachingFor('Read', { file_path: planted }), { workspaceEnv: { CLAUDE_CONFIG_DIR: configDir } });
    const approval = approvalSpy(false);
    await svc.startConversation(request({ approval }));

    expect(controlAnswer(spawned.processes[0])).toBe('deny');
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'external_path', subject: resolved(join(outside, 'secret.txt')) }));
  });

  it('reads the workspace and its saved output with nobody to ask, and refuses the rest', async () => {
    const { configDir, file } = savedResult('sess');
    const root = repo({ 'src/a.ts': 'export const a = 1;' });
    for (const [target, answer] of [[join(root, 'src/a.ts'), 'allow'], [file, 'allow'], ['/etc/hosts', 'deny']] as const) {
      const { svc, spawned } = service('claude-code', root, reachingFor('Read', { file_path: target }), { workspaceEnv: { CLAUDE_CONFIG_DIR: configDir } });
      await svc.startConversation(request());
      expect(controlAnswer(spawned.processes[0])).toBe(answer);
    }
  });
});
