import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join, resolve, sep } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PiAdapter } from '../harness/PiAdapter';
import { SessionNotResumable } from '../harness/ordewellBinding';
import { piMcpCollision } from '../harness/piOrdewell';
import { PI_ORDEWELL } from '../harness/piOrdewell';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskStartOptions } from '../harness/AgentAdapter';
import type { ApprovalRequest, IApproval } from '../../interfaces/IApproval';
import { decidePlannerPermission } from '../harness/plannerPermissions';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { PI_MANIFEST } from '../../plugins/builtin/pi.manifest';
import { OrdewellMcpServer, mcpClientConfig, type McpClientConfig } from '../mcp';
import { StructuredRunner } from '../StructuredRunner';
import { VerdictEngine } from '../VerdictEngine';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { createTask, type Verdict } from '../../models/Task';
import { argvWithFiles, silentSpawn, type FakeAgentProcess, type FakeSpawnResult } from './harnessTestKit';

/**
 * The Pi adapter against Pi 1.5.2 as it was recorded over `pi --mode rpc`
 * (`fixtures/pi/`), with this adapter live on Ordewell's side: each line it
 * writes is answered with what Pi wrote after the same line in the recording.
 * The read-only, planner, repeated-completion, thinking-only and resume runs
 * were made on a scripted model, so Pi made exact calls, the resume in a moved
 * cwd on Pi 1.6.0; cancel and the unreachable provider on Ollama's qwen3:8b.
 */

const FIXTURES = join(__dirname, 'fixtures/pi');
/** Native paths that are not on disk, so a read is judged where it is written, on every host. */
const BASE = join(tmpdir(), `ordewell-pi-replay-${randomUUID()}`);
const CWD = join(BASE, 'task');
const WORKSPACE = join(BASE, 'workspace');
/** Where a continuation runs after its run ended: a new worktree, not the cwd its session was saved in. */
const MOVED = join(BASE, 'moved');
const PLACES: Record<string, string> = { CWD, WORKSPACE, MOVED, OUTSIDE: join(BASE, 'outside'), WORK: BASE, PRIVATE_DIR: join(BASE, 'private'), HOME: join(BASE, 'home') };

type PiRecord = Record<string, unknown> & { type?: string; id?: string; message?: unknown };
type Recorded = { dir: 'in' | 'out'; ms: number; line: PiRecord } | { dir: 'note'; ms: number; event: string; args?: string[]; [key: string]: unknown };

function recording(name: string): Recorded[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => placed(JSON.parse(line)) as Recorded);
}

/**
 * A recorded value with its marks filled in by this host's paths. A mark in a
 * JSON document carried as a string (a read ask's placeholder, a decision) is
 * filled inside that document, so a Windows path is escaped once per level,
 * and the path after a mark takes this host's separator, as Pi and the
 * adapter write it here.
 */
function placed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(placed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, placed(inner)]));
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  if (/^[[{]/.test(value)) {
    try {
      return JSON.stringify(placed(JSON.parse(value)));
    } catch {
      // Text that only starts like JSON.
    }
  }
  return value.replace(/\{\{(\w+)\}\}((?:\/[\w.*@~+-]*)*)/g, (whole, mark: string, rest: string) => (mark in PLACES ? PLACES[mark] + rest.replaceAll('/', sep) : whole));
}

const wire = (entries: Recorded[]) => entries.flatMap((entry) => (entry.dir === 'note' ? [] : [entry]));
const outs = (entries: Recorded[]) => wire(entries).flatMap((entry) => (entry.dir === 'out' ? [entry.line] : []));

/**
 * Pi's side of a recording: for each process it started, what Pi wrote after
 * each line Ordewell wrote, sent once the adapter writes that line again.
 */
function replay(name: string): FakeSpawnResult {
  const processes: PiRecord[][][] = [];
  for (const entry of recording(name)) {
    if (entry.dir === 'note') {
      if (entry.event === 'spawn') processes.push([[]]);
      continue;
    }
    const segments = processes[processes.length - 1];
    if (entry.dir === 'out') segments.push([]);
    else segments[segments.length - 1].push(entry.line);
  }
  const answered = new Map<FakeAgentProcess, number>();
  const kit: FakeSpawnResult = silentSpawn((written, proc) => {
    const segments = processes[kit.processes.indexOf(proc)];
    const lines = written.split('\n').filter(Boolean).length;
    for (let i = 0; i < lines; i++) {
      const next = (answered.get(proc) ?? 0) + 1;
      answered.set(proc, next);
      const answer = segments[next] ?? [];
      // Pi answers after the write returns, as a real process does.
      setImmediate(() => proc.emitStdout(answer.map((line) => `${JSON.stringify(line)}\n`).join('')));
    }
  });
  return kit;
}

function deps(kit: FakeSpawnResult): AgentProcessDeps {
  return { spawn: kit.spawn, fetch: globalThis.fetch, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true, workspaceEnv: async () => ({}) };
}

const mcp = (extra: Partial<McpClientConfig> = {}): McpClientConfig => ({
  ...mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' }),
  contact: { contacted: () => true, whenContacted: async () => true },
  ...extra,
});

function taskStart(mode: string, extra: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return { kind: 'task', cwd: CWD, workspaceRoot: WORKSPACE, model: 'script/read-only', mode, flags: resolveTaskRunnerFlags(PI_MANIFEST, { mode }), mcp: mcp(), ...extra };
}

const plannerStart = (extra: Partial<AgentStartOptions> = {}): AgentStartOptions => ({ kind: 'planner', cwd: CWD, systemPrompt: 'PLAN', mcp: mcp(), ...extra } as AgentStartOptions);

const adapters: PiAdapter[] = [];
/** Directories a test made on disk, removed after it. */
const temps: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const adapter of adapters.splice(0)) adapter.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The directory Pi files a cwd's sessions in under an agent dir (Pi 1.6.0's getDefaultSessionDirPath). */
const piSessions = (agent: string, cwd: string) => join(agent, 'sessions', `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);

/** An agent dir of Pi's own on disk, holding session `id` as Pi files it for each cwd of `cwds`, the last written last. */
function savedSessions(id: string, ...cwds: string[]): { agent: string; files: string[] } {
  const agent = mkdtempSync(join(tmpdir(), 'ordewell-pi-agent-'));
  temps.push(agent);
  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  const files = cwds.map((cwd, i) => {
    const dir = piSessions(agent, cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `2026-11-20T10-00-0${i}-000Z_${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd: resolve(cwd) })}\n`);
    utimesSync(file, 1_000 + i, 1_000 + i);
    return file;
  });
  return { agent, files };
}

async function started(kit: FakeSpawnResult, start: AgentStartOptions): Promise<PiAdapter> {
  const adapter = new PiAdapter(deps(kit));
  adapters.push(adapter);
  await adapter.start(start);
  return adapter;
}

/** The prompt a recording's process was sent as its `n`th turn. */
function prompt(name: string, n = 0): string {
  return outs(recording(name)).filter((line) => line.type === 'prompt')[n].message as string;
}

const written = (proc: FakeAgentProcess) => proc.written.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as PiRecord);

describe('Pi\'s command line', () => {
  it('starts a writable task natively, its token and contract in owner-only files outside the worktree', async () => {
    const kit = silentSpawn(() => {});
    const adapter = await started(kit, taskStart('agent', { model: 'anthropic/claude-sonnet-5.5', flags: { ...resolveTaskRunnerFlags(PI_MANIFEST, { mode: 'agent' }), effort: 'high' } }));
    const { args, files } = argvWithFiles(kit.lastLaunch());

    expect(args).toEqual(['--mode', 'rpc', '--session-id', adapter.nativeSessionId(), '--session-dir', expect.any(String), '-e', 'builtin:mcp', '-e', '<ordewell.ts>', '--append-system-prompt', '<instructions.md>', '--model', 'anthropic/claude-sonnet-5.5', '--thinking', 'high']);
    expect(kit.lastArgs().join(' ')).not.toContain('tok-secret');
    expect(files['ordewell.ts']).toContain('"url":"http://127.0.0.1:4555/mcp","headers":{"Authorization":"Bearer tok-secret"}},"asksReads":false');
    expect(files['instructions.md']).toContain('call the `task_complete` tool with status `done`');
    for (const file of kit.lastLaunch().files.keys()) {
      expect(file.startsWith(CWD)).toBe(false);
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('starts a read-only task on Pi\'s read tools and Ordewell\'s, with nothing of the repository\'s or the user\'s that runs and no context file Pi finds itself', async () => {
    const kit = silentSpawn(() => {});
    await started(kit, taskStart('plan', { runnerConfig: 'minimal', mcp: mcp({ readOnly: true }) }));
    const { args, files } = argvWithFiles(kit.lastLaunch());

    expect(args.slice(12)).toEqual(['--no-approve', '--no-extensions', '--tools', `read,grep,find,ls,${PI_ORDEWELL.toolNames('readOnlyTask').join(',')}`, '--no-context-files', '--no-skills', '--no-prompt-templates', '--model', 'script/read-only']);
    expect(files['ordewell.ts']).toContain('"asksReads":true');
    expect(files['instructions.md']).toContain('This task is read-only');
    expect(files['instructions.md']).toContain('`mcp__ordewell__read` reads a task\'s handoff, not a file');
    expect(files['instructions.md']).toContain('call the `task_complete` tool with status `done`');
  });

  it('hands a read-only task its repository\'s instruction files as text, never one a link takes out of the repository (ADR-0028)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-pi-context-'));
    temps.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'pkg'));
    writeFileSync(join(root, 'AGENTS.md'), 'OUTSIDE: the user\'s own notes');
    writeFileSync(join(repo, 'AGENTS.md'), 'Use tabs.');
    const links = process.platform !== 'win32';
    if (links) symlinkSync(join(root, 'AGENTS.md'), join(repo, 'pkg', 'AGENTS.md'));
    const kit = silentSpawn(() => {});
    await started(kit, taskStart('plan', { cwd: join(repo, 'pkg'), mcp: mcp({ readOnly: true }) }));
    const { args, files } = argvWithFiles(kit.lastLaunch());

    expect(args).toContain('--no-context-files');
    expect(files['instructions.md']).toContain('=== ../AGENTS.md ===\nUse tabs.');
    expect(files['instructions.md']).toContain('they do not change what you may do in this read-only task');
    if (links) expect(files['instructions.md']).not.toContain('OUTSIDE');
  });

  it('starts a planner restricted the same way, its prompt appended to Pi\'s own with its tools named (ADR-0009, T5)', async () => {
    const kit = silentSpawn(() => {});
    await started(kit, plannerStart({ model: 'ollama/qwen3:8b', effort: 'low', mcp: mcp({ hidden: ['web_search'] }) } as Partial<AgentStartOptions>));
    const { args, files } = argvWithFiles(kit.lastLaunch());

    expect(args.slice(12)).toEqual(['--no-approve', '--no-extensions', '--tools', `read,grep,find,ls,${PI_ORDEWELL.toolNames('planner', ['web_search']).join(',')}`, '--no-context-files', '--model', 'ollama/qwen3:8b', '--thinking', 'low']);
    // Exact names: a pattern would let in the tools of a server named `ordewell__x`, which Pi names `mcp__ordewell__x__<tool>`.
    expect(args[15].split(',').every((tool) => !tool.includes('*'))).toBe(true);
    expect(files['instructions.md']).toMatch(/^PLAN\n\nYour Ordewell tools come from the `ordewell` MCP server: `mcp__ordewell__list_runners`/);
    expect(files['instructions.md']).toContain('read web pages with `mcp__ordewell__fetch`');
    expect(files['instructions.md']).not.toContain('web_search');
    expect(files['instructions.md']).not.toContain('task_complete');
  });

  it('offers a task whose flags make it read-only the read-only token\'s tools, as it restricts it', async () => {
    const kit = silentSpawn(() => {});
    await started(kit, taskStart('plan'));
    const { args } = argvWithFiles(kit.lastLaunch());

    expect(args.slice(12, 16)).toEqual(['--no-approve', '--no-extensions', '--tools', `read,grep,find,ls,${PI_ORDEWELL.toolNames('readOnlyTask').join(',')}`]);
  });

  /** The directory Pi files `/work/repo`'s sessions in by default. */
  const defaultSessions = (agentDir: string) => piSessions(agentDir, '/work/repo');

  it('names the session directory on every start, Pi\'s own default for the cwd, so a repository\'s .pi settings cannot move it', async () => {
    for (const start of [plannerStart({ cwd: '/work/repo' }), taskStart('plan', { cwd: '/work/repo', mcp: mcp({ readOnly: true }) }), taskStart('agent', { cwd: '/work/repo' })]) {
      const kit = silentSpawn(() => {});
      await started(kit, start);
      const args = kit.lastArgs();
      expect(args[args.indexOf('--session-dir') + 1]).toBe(defaultSessions(join(homedir(), '.pi', 'agent')));
    }
  });

  it('files the sessions under the agent dir the workspace or the host names, as Pi does', async () => {
    const agent = resolve('/agents/pi');
    for (const [workspace, host, expected] of [
      [{ PI_CODING_AGENT_DIR: agent }, 'ignored', agent],
      [{}, agent, agent],
      [{ PI_CODING_AGENT_DIR: '~/pi-agent' }, '', join(homedir(), 'pi-agent')],
      [{ PI_CODING_AGENT_DIR: '~' }, '', homedir()],
      // Relative, against the cwd Pi starts in.
      [{ PI_CODING_AGENT_DIR: join('rel', 'agent') }, '', resolve('/work/repo', 'rel', 'agent')],
    ] as const) {
      vi.stubEnv('PI_CODING_AGENT_DIR', host);
      const kit = silentSpawn(() => {});
      const adapter = new PiAdapter({ ...deps(kit), workspaceEnv: async () => ({ ...workspace }) });
      adapters.push(adapter);
      await adapter.start(taskStart('agent', { cwd: '/work/repo' }));
      const args = kit.lastArgs();
      expect(args[args.indexOf('--session-dir') + 1]).toBe(defaultSessions(expected));
    }
  });

  it('names a placed Pi\'s session directory where it runs, under that host\'s home, and reads no mcp.json of this one', async () => {
    const agent = mkdtempSync(join(tmpdir(), 'ordewell-pi-agent-'));
    temps.push(agent);
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { ordewell: { command: 'x' } } }));
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    const placed: { args: readonly string[] }[] = [];
    const kit = silentSpawn(() => {});
    const adapter = new PiAdapter({ ...deps(kit), placement: {
      cwd: '/work/task',
      place: async (launch) => { placed.push(launch); return { command: launch.command, args: [...launch.args], env: { ...launch.env }, stop: () => {}, ended: () => {} }; },
      reach: async (url) => url,
      blob: async () => undefined,
    } });
    adapters.push(adapter);
    await adapter.start(taskStart('agent'));

    expect(placed[0].args.slice(4, 6)).toEqual(['--session-dir', '~/.pi/agent/sessions/--work-task--']);
  });

  it('refuses to start, naming the file, when the user\'s own Pi mcp.json has a server that would displace Ordewell\'s', async () => {
    const agent = mkdtempSync(join(tmpdir(), 'ordewell-pi-agent-'));
    temps.push(agent);
    writeFileSync(join(agent, 'mcp.json'), JSON.stringify({ mcpServers: { ordewell: { command: 'ordewell-mcp', enabled: false } } }));
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    const kit = silentSpawn(() => {});

    await expect(new PiAdapter(deps(kit)).start(plannerStart())).rejects.toThrow(`${join(agent, 'mcp.json')} defines an MCP server named "ordewell", which Pi starts in place of Ordewell's own`);
    expect(kit.processes).toHaveLength(0);
  });

  it('finds a displacing server as Pi names servers, by namespace, and nothing else in the file', () => {
    const agent = mkdtempSync(join(tmpdir(), 'ordewell-pi-agent-'));
    temps.push(agent);
    const file = join(agent, 'mcp.json');
    const verdict = (servers: unknown, name = 'ordewell') => {
      writeFileSync(file, typeof servers === 'string' ? servers : JSON.stringify({ mcpServers: servers }));
      return piMcpCollision(agent, name);
    };

    expect(piMcpCollision(agent, 'ordewell')).toBeUndefined();
    expect(verdict({ docs: { url: 'https://example.com/mcp' }, ordewell2: { command: 'x' } })).toBeUndefined();
    expect(verdict({ ordewell: { url: 'https://example.com/mcp' } })).toBe('ordewell');
    // Pi gives `-` and `_` one namespace.
    expect(verdict({ ordewell_x: { command: 'x' } }, 'ordewell-x')).toBe('ordewell_x');
    // An entry Pi refuses to load displaces nothing.
    expect(verdict({ ordewell: { type: 'sse', url: 'https://example.com/sse' } })).toBeUndefined();
    expect(verdict({ ordewell: { args: ['x'] } })).toBeUndefined();
    expect(verdict({ ordewell: { type: 'stdio', command: 'x' } })).toBe('ordewell');
    expect(verdict({ ordewell: { type: 'http', url: 'https://example.com/mcp' } })).toBe('ordewell');
    expect(verdict({ ordewell: { type: 'streamable-http', url: 'https://example.com/mcp' } })).toBe('ordewell');
    expect(verdict({ ordewell: { type: 'stdio', url: 'https://example.com/mcp' } })).toBeUndefined();
    expect(verdict(`\uFEFF${JSON.stringify({ mcpServers: { ordewell: { command: 'x' } } })}`)).toBe('ordewell');
    // A name Pi refuses outright.
    expect(verdict({ 'ordewell.x': { command: 'x' } }, 'ordewell.x')).toBeUndefined();
    expect(verdict('{ not json')).toBeUndefined();
    expect(verdict('[]')).toBeUndefined();
    expect(verdict('{}')).toBeUndefined();
    expect(verdict({ ordewell: 'x' })).toBeUndefined();
  });

  /** A Pi that answers the resume check's `get_state` with `messageCount` messages in the session. */
  const holding = (messageCount: number) => silentSpawn((text, proc) => {
    for (const line of text.split('\n').filter(Boolean).map((raw) => JSON.parse(raw) as PiRecord)) {
      if (line.type === 'get_state') proc.emitStdout(`${JSON.stringify({ id: line.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'sess-1', messageCount, isStreaming: false } })}\n`);
    }
  });

  it('takes a session up again by the id it was started with, once Pi says the session holds its messages (ADR-0018, K1)', async () => {
    const kit = holding(4);
    const adapter = await started(kit, taskStart('agent', { resumeSessionId: 'sess-1' }));

    expect(kit.lastArgs().slice(2, 4)).toEqual(['--session-id', 'sess-1']);
    expect(written(kit.processes[0])).toEqual([{ id: 'ordewell-resume-check', type: 'get_state' }]);
    expect(adapter.nativeSessionId()).toBe('sess-1');
  });

  it('takes up a session saved under another cwd, a continuation\'s new worktree, by forking its file into the cwd it runs in under the same id', async () => {
    const { agent, files: [saved] } = savedSessions('sess-1', '/work/run-1/task');
    const kit = holding(4);
    const adapter = await started(kit, taskStart('agent', { cwd: '/work/run-2/task', resumeSessionId: 'sess-1' }));

    expect(kit.lastArgs().slice(2, 8)).toEqual(['--session-id', 'sess-1', '--session-dir', piSessions(agent, '/work/run-2/task'), '--fork', saved]);
    expect(adapter.nativeSessionId()).toBe('sess-1');
  });

  it('forks the latest copy of a session continued in several worktrees, and none where the cwd has its own, which Pi takes up by id', async () => {
    const { files } = savedSessions('sess-1', '/work/run-1/task', '/work/run-3/task', '/work/run-2/task');
    const moved = holding(4);
    await started(moved, taskStart('agent', { cwd: '/work/run-4/task', resumeSessionId: 'sess-1' }));
    expect(moved.lastArgs()[moved.lastArgs().indexOf('--fork') + 1]).toBe(files[2]);

    const home = holding(4);
    await started(home, taskStart('agent', { cwd: '/work/run-3/task', resumeSessionId: 'sess-1' }));
    expect(home.lastArgs()).not.toContain('--fork');
  });

  it('calls a session lost whose saved file Pi cannot fork, as it does one that is gone', async () => {
    const { files: [saved] } = savedSessions('sess-1', '/work/run-1/task');
    writeFileSync(saved, '');
    // Pi 1.6.0's words for a file it cannot read a session from, before it answers anything.
    const kit = silentSpawn((_text, proc) => {
      proc.emitStderr(`Error: Cannot fork: source session file is empty or invalid: ${saved}\n`);
      proc.exit(1);
    });
    const refused = new PiAdapter(deps(kit)).start(taskStart('agent', { cwd: '/work/run-2/task', resumeSessionId: 'sess-1' }));

    await expect(refused).rejects.toBeInstanceOf(SessionNotResumable);
    await expect(refused).rejects.toThrow(`Pi could not take up session sess-1 from ${saved}: Error: Cannot fork: source session file is empty or invalid`);
  });

  it('forks nothing on a fresh start, or for a session no cwd saved, which the resume check then refuses', async () => {
    savedSessions('sess-1', '/work/run-1/task');
    const fresh = silentSpawn(() => {});
    await started(fresh, taskStart('agent', { cwd: '/work/run-2/task' }));
    expect(fresh.lastArgs()).not.toContain('--fork');

    const lost = holding(0);
    await expect(new PiAdapter(deps(lost)).start(taskStart('agent', { cwd: '/work/run-2/task', resumeSessionId: 'sess-2' }))).rejects.toBeInstanceOf(SessionNotResumable);
    expect(lost.lastArgs()).not.toContain('--fork');
  });

  it('refuses a resume Pi answered with a new, empty session, which it does for an id it cannot find', async () => {
    for (const start of [taskStart('agent', { resumeSessionId: 'sess-1' }), plannerStart({ resumeSessionId: 'sess-1' })]) {
      const kit = holding(0);
      const refused = new PiAdapter(deps(kit)).start(start);

      await expect(refused).rejects.toBeInstanceOf(SessionNotResumable);
      await expect(refused).rejects.toThrow('Pi has no saved session sess-1 to continue.');
      expect(kit.processes[0].killed).toBe(true);
    }
  });

  it('fails a resume Pi could not report on, or did not answer in time, without calling the session lost', async () => {
    const refusing = silentSpawn((text, proc) => {
      if (text.includes('get_state')) proc.emitStdout(`${JSON.stringify({ id: 'ordewell-resume-check', type: 'response', command: 'get_state', success: false, error: 'not ready' })}\n`);
    });
    const failed = new PiAdapter(deps(refusing)).start(taskStart('agent', { resumeSessionId: 'sess-1' }));
    await expect(failed).rejects.toThrow('Pi could not say whether it found session sess-1: not ready.');
    await expect(failed).rejects.not.toBeInstanceOf(SessionNotResumable);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const silent = new PiAdapter(deps(silentSpawn(() => {}))).start(taskStart('agent', { resumeSessionId: 'sess-1' }));
      const settled = silent.catch((err: Error) => err);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await settled).toMatchObject({ message: 'Pi did not say within 30s whether it found session sess-1.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a resume Pi exits on before it answers, in its own last words', async () => {
    const kit = silentSpawn((text, proc) => {
      if (text.includes('get_state')) {
        proc.emitStderr('Error: the session file is corrupt\n');
        proc.exit(1);
      }
    });

    await expect(new PiAdapter(deps(kit)).start(taskStart('agent', { resumeSessionId: 'sess-1' }))).rejects.toThrow(/exited with code 1[\s\S]*the session file is corrupt/);
  });

  it('says nothing of Pi\'s warning that a fresh start\'s id is new, which every fresh start prints, when it fails', async () => {
    const kit = silentSpawn(() => {});
    const adapter = await started(kit, taskStart('agent'));
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (event) => events.push(event));
    kit.processes[0].emitStderr(`Warning: No project session found with id '${adapter.nativeSessionId()}'; creating a new session with that id.\nError: No API key found for openai.\n`);
    kit.processes[0].exit(1);
    await turn;

    expect(events).toEqual([{ type: 'error', message: 'The pi task runner exited with code 1.\n\nError: No API key found for openai.' }]);
  });

  it('names Ordewell\'s tools as Pi does under direct exposure, hides none from a planner and holds none of Pi\'s requests for them', () => {
    expect(PI_ORDEWELL.toolNames('readOnlyTask')).toEqual(['task_complete', 'checkpoint', 'read', 'run_command', 'save_patch', 'fetch', 'web_search'].map((tool) => `mcp__ordewell__${tool}`));
    expect(PI_ORDEWELL.plannerHidden(plannerStart() as Extract<AgentStartOptions, { kind: 'planner' }>)).toEqual([]);
    expect(PI_ORDEWELL.isOrdewellAsk(undefined as never)).toBe(false);
    expect(['connected', 'failed', 'pending', undefined].map((status) => PI_ORDEWELL.attachState(status))).toEqual(['connected', 'failed', 'pending', 'pending']);
  });

  it('turns jiti\'s file cache off on every start, which would keep the extension and its token in the temp dir after Pi exits', async () => {
    for (const start of [plannerStart(), taskStart('plan', { mcp: mcp({ readOnly: true }) }), taskStart('agent')]) {
      const kit = silentSpawn(() => {});
      await started(kit, start);
      expect(kit.lastEnv().JITI_FS_CACHE).toBe('false');
    }
  });

  it('starts every Pi on Windows with the current directory out of its program search, so a repository\'s rg.exe or fd.exe is never what Pi runs', async () => {
    for (const start of [plannerStart(), taskStart('plan', { mcp: mcp({ readOnly: true }) }), taskStart('agent')]) {
      const kit = silentSpawn(() => {});
      const adapter = new PiAdapter({ ...deps(kit), platform: 'win32' });
      adapters.push(adapter);
      await adapter.start(start);
      expect(kit.lastEnv().NoDefaultCurrentDirectoryInExePath).toBe('1');
    }
    // Elsewhere nothing adds it; the host's own value would otherwise pass through.
    vi.stubEnv('NoDefaultCurrentDirectoryInExePath', undefined);
    const kit = silentSpawn(() => {});
    await started(kit, plannerStart());
    expect(kit.lastEnv().NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });

  it('refuses to start without Ordewell\'s server', async () => {
    await expect(new PiAdapter(deps(silentSpawn(() => {}))).start({ ...taskStart('agent'), mcp: undefined })).rejects.toThrow('cannot start without the Ordewell MCP server');
  });
});

describe('Pi\'s recorded runs, replayed', () => {
  it('refuses a read-only task\'s reads outside both roots with core\'s reason and no approval card, and reads inside them (ADR-0046)', async () => {
    const kit = replay('read-only');
    const adapter = await started(kit, taskStart('plan', { mcp: mcp({ readOnly: true }) }));
    const events: AgentEvent[] = [];

    await adapter.send(prompt('read-only'), (event) => events.push(event));

    expect(written(kit.processes[0])).toEqual(outs(recording('read-only')));
    const requests = events.filter((e): e is Extract<AgentEvent, { type: 'permission_request' }> => e.type === 'permission_request');
    expect(requests.map((r) => [r.name, r.detail, r.decided?.decision])).toEqual([
      ['ls', PLACES.OUTSIDE, 'deny'],
      ['read', join(PLACES.OUTSIDE, 'secret.txt'), 'deny'],
      ['read', join(PLACES.OUTSIDE, 'secret.txt'), 'deny'],
      ['read', join(PLACES.OUTSIDE, 'secret.txt'), 'deny'],
      ['grep', PLACES.OUTSIDE, 'deny'],
      ['read', join(CWD, 'inside.txt'), 'allow'],
      ['read', join(WORKSPACE, 'shared.txt'), 'allow'],
    ].map(([tool, path, decision]) => [tool, expect.stringContaining(path.replace(BASE, '')), decision]));
    expect(requests.every((r) => r.decided)).toBe(true);
    expect(adapter.answerPermission(requests[0].id, { decision: 'allow' })).toBe(false);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.filter((e) => e.type === 'tool_result' && !e.success).map((e) => e.type === 'tool_result' && e.output)).toEqual(Array(5).fill('This read is outside the task worktree and workspace. Nobody can approve it here.'));
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('holds a planner\'s reads for its envelope, which puts one outside the workspace to the external_path policy (ADR-0026)', async () => {
    const kit = replay('planner');
    const adapter = await started(kit, plannerStart());
    const cards: ApprovalRequest[] = [];
    const approval = { request: async (request: ApprovalRequest) => { cards.push(request); return false; } } as unknown as IApproval;
    const events: AgentEvent[] = [];

    await adapter.send(prompt('planner'), (event) => {
      events.push(event);
      if (event.type === 'permission_request' && !event.decided) {
        void decidePlannerPermission(event.ask, event.input ?? {}, { workspaceRoot: CWD, approval }).then((decision) => adapter.answerPermission(event.id, decision));
      }
    });

    expect(written(kit.processes[0])).toEqual(outs(recording('planner')));
    expect(cards.map((card) => [card.kind, card.subject])).toEqual([['external_path', BASE], ['external_path', join(PLACES.OUTSIDE, 'secret.txt')]]);
    const asked = events.filter((e) => e.type === 'permission_request');
    expect(asked.map((e) => e.type === 'permission_request' && [e.toolUseId, e.ask])).toEqual([
      ['call_0_0', { kind: 'path', path: BASE, directory: true }],
      ['call_0_1', { kind: 'path', path: join(PLACES.OUTSIDE, 'secret.txt'), directory: false }],
      ['call_0_2', { kind: 'path', path: join(CWD, 'inside.txt'), directory: false }],
    ]);
  });

  it('reports each call Pi makes, its repeated task_complete calls included, and the turn that ended (#78)', async () => {
    const kit = replay('task-repeat');
    const adapter = await started(kit, taskStart('agent'));
    const events: AgentEvent[] = [];

    await adapter.send(prompt('task-repeat'), (event) => events.push(event));

    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.type === 'tool_call' && e.name)).toEqual(['write', ...Array(5).fill('mcp__ordewell__task_complete')]);
    expect(events.filter((e) => e.type === 'permission_request')).toEqual([]);
    expect(events.filter((e) => e.type === 'assistant_text')).toEqual([{ type: 'assistant_text', runId: '1.7.0', text: 'Done.' }]);
    expect(events.filter((e) => e.type === 'usage')[0]).toEqual({ type: 'usage', record: { source: 'pi', model: 'script/task-repeat', inputTokens: 7610, outputTokens: 20, cachedInputTokens: 0, contextTokens: 7630 } });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
  });

  it('ends a turn that only thought as a turn, with no reply in it (#78)', async () => {
    const kit = replay('think-only');
    const adapter = await started(kit, taskStart('agent'));
    const events: AgentEvent[] = [];

    await adapter.send(prompt('think-only'), (event) => events.push(event));

    expect(events.map((e) => e.type)).toEqual(['thinking_delta', 'thinking', 'usage', 'turn_end']);
  });

  it('stops a turn with Pi\'s abort and keeps the session for the next one', async () => {
    const kit = replay('cancel');
    const adapter = await started(kit, taskStart('agent'));
    const events: AgentEvent[] = [];
    let interrupted: Promise<boolean> | null = null;

    await adapter.send(prompt('cancel'), (event) => {
      events.push(event);
      if (!interrupted && event.type.endsWith('_delta')) interrupted = adapter.interrupt(5_000);
    });

    expect(await interrupted).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    events.length = 0;
    await adapter.send(prompt('cancel', 1), (event) => events.push(event));
    expect(written(kit.processes[0])).toEqual(outs(recording('cancel')));
    expect(events.filter((e) => e.type === 'assistant_text').map((e) => e.type === 'assistant_text' && e.text)).toEqual(['ok']);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(await adapter.interrupt(100)).toBe(false);
  });

  it('takes a session up again in a new process, which answers from its history', async () => {
    const kit = replay('resume');
    const first = await started(kit, taskStart('agent'));
    await first.send(prompt('resume'), () => {});
    const session = recording('resume').find((entry) => entry.dir === 'note' && entry.event === 'session') as unknown as { sessionId: string };
    first.endInput();
    expect(kit.processes[0].stdinEnded).toBe(true);

    const second = await started(kit, taskStart('agent', { resumeSessionId: session.sessionId }));
    const events: AgentEvent[] = [];
    await second.send(prompt('resume', 1), (event) => events.push(event));

    const spawns = recording('resume').filter((entry) => entry.dir === 'note' && entry.event === 'spawn').map((entry) => (entry as { args: string[] }).args);
    expect(spawns.map((args) => args[args.indexOf('--session-id') + 1])).toEqual([expect.any(String), session.sessionId]);
    expect(kit.lastArgs().slice(2, 4)).toEqual(['--session-id', session.sessionId]);
    // The scripted model says what reached it: the history the resumed process gave it.
    expect(events.filter((e) => e.type === 'assistant_text').map((e) => e.type === 'assistant_text' && e.text)).toEqual([`2 user messages; the first: ${prompt('resume')}`]);
  });

  it('takes a session up again in a new process in another worktree, which answers from the history Pi forked into it', async () => {
    const kit = replay('resume-moved');
    const spawns = recording('resume-moved').filter((entry) => entry.dir === 'note' && entry.event === 'spawn').map((entry) => (entry as { args: string[] }).args);
    const session = recording('resume-moved').find((entry) => entry.dir === 'note' && entry.event === 'session') as unknown as { sessionId: string };
    // What the first process left on disk, which a replay does not: the file Pi saved the session in, under the first cwd's directory.
    const { agent, files: [saved] } = savedSessions(session.sessionId, CWD);
    const forked = join(dirname(saved), spawns[1][spawns[1].indexOf('--fork') + 1].split(/[/\\]/).at(-1)!);
    renameSync(saved, forked);
    const first = await started(kit, taskStart('agent'));
    await first.send(prompt('resume-moved'), () => {});
    first.endInput();

    const second = await started(kit, taskStart('agent', { cwd: MOVED, resumeSessionId: session.sessionId }));
    const events: AgentEvent[] = [];
    await second.send(prompt('resume-moved', 1), (event) => events.push(event));

    expect(spawns[1].slice(2, 4)).toEqual(['--session-id', session.sessionId]);
    expect(kit.lastArgs().slice(2, 8)).toEqual(['--session-id', session.sessionId, '--session-dir', piSessions(agent, MOVED), '--fork', forked]);
    expect([...written(kit.processes[0]), ...written(kit.processes[1])]).toEqual(outs(recording('resume-moved')));
    // The scripted model says what reached it: the first process's prompt, carried into the new cwd.
    expect(events.filter((e) => e.type === 'assistant_text').map((e) => e.type === 'assistant_text' && e.text)).toEqual([`2 user messages; the first: ${prompt('resume-moved')}`]);
  });

  it('fails a turn whose model call failed after Pi\'s retries, in Pi\'s words', async () => {
    const kit = replay('error');
    const adapter = await started(kit, taskStart('agent'));
    const events: AgentEvent[] = [];

    await adapter.send(prompt('error'), (event) => events.push(event));

    expect(events).toEqual([{ type: 'error', message: 'Connection error.: bad port' }]);
  });
});

describe('Pi\'s dialogs and its other answers', () => {
  /** A started adapter, its process, and the events of an open turn. */
  async function inTurn(start: AgentStartOptions) {
    const kit = silentSpawn(() => {});
    const adapter = await started(kit, start);
    const events: AgentEvent[] = [];
    const turn = adapter.send('go', (event) => events.push(event));
    const proc = kit.processes[0];
    const say = (line: Record<string, unknown>) => proc.emitStdout(`${JSON.stringify(line)}\n`);
    return { adapter, proc, events, turn, say };
  }

  it('puts an extension\'s confirm in a writable task to a person, and dismisses the dialogs nobody could answer', async () => {
    const { adapter, proc, events, say } = await inTurn(taskStart('agent'));
    say({ type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Run rm -rf build?', message: 'The gate asks.' });
    say({ type: 'extension_ui_request', id: 's1', method: 'select', title: 'Pick one', options: ['a', 'b'] });
    say({ type: 'extension_ui_request', id: 'r1', method: 'input', title: 'ordewell:read', placeholder: '{"toolCallId":"t","tool":"read","path":"/etc/hosts","directory":false}' });
    say({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'MCP servers need attention' });

    expect(events.filter((e) => e.type === 'permission_request')).toEqual([{ type: 'permission_request', id: 'c1', name: 'Run rm -rf build?', detail: 'The gate asks.', suggestions: [] }]);
    expect(adapter.answerPermission('c1', { decision: 'allow' })).toBe(true);
    expect(written(proc).slice(1)).toEqual([
      { type: 'extension_ui_response', id: 's1', cancelled: true },
      { type: 'extension_ui_response', id: 'r1', cancelled: true },
      { type: 'extension_ui_response', id: 'c1', confirmed: true },
    ]);
  });

  it('refuses an extension\'s confirm on a read-only task without asking anyone (ADR-0046)', async () => {
    const { proc, events, say } = await inTurn(taskStart('plan'));
    say({ type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Write it?' });

    expect(events.filter((e) => e.type === 'permission_request')).toMatchObject([{ id: 'c1', decided: { decision: 'deny' } }]);
    expect(written(proc).at(-1)).toEqual({ type: 'extension_ui_response', id: 'c1', confirmed: false });
  });

  it('withdraws a planner\'s read still open when the turn ends', async () => {
    const { adapter, events, say, turn } = await inTurn(plannerStart());
    say({ type: 'extension_ui_request', id: 'r1', method: 'input', title: 'ordewell:read', placeholder: JSON.stringify({ toolCallId: 't1', tool: 'ls', path: BASE, directory: true }) });
    say({ type: 'agent_settled', aborted: false });
    await turn;

    expect(events).toEqual([
      { type: 'permission_request', id: 'r1', name: 'ls', detail: BASE, input: { path: BASE }, toolUseId: 't1', ask: { kind: 'path', path: BASE, directory: true } },
      { type: 'permission_cancelled', id: 'r1' },
      { type: 'turn_end' },
    ]);
    expect(adapter.answerPermission('r1', { decision: 'allow' })).toBe(false);
  });

  it('ends a turn whose prompt Pi ran as a command of its own once Pi says no run is going', async () => {
    const { proc, events, say, turn } = await inTurn(taskStart('agent'));
    say({ id: 'turn-1', type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });

    expect(written(proc).at(-1)).toEqual({ id: 'ordewell-idle-check-1', type: 'get_state' });
    say({ id: 'ordewell-idle-check-1', type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
    await turn;
    expect(events).toEqual([{ type: 'turn_end' }]);
  });

  it('keeps the turn of a handled prompt open for the run its command started, until Pi settles', async () => {
    const { events, say, turn } = await inTurn(taskStart('agent'));
    say({ id: 'turn-1', type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    say({ id: 'ordewell-idle-check-1', type: 'response', command: 'get_state', success: true, data: { isStreaming: true } });
    say({ type: 'agent_start' });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Asked.' }] };
    say({ type: 'message_start', message });
    say({ type: 'message_end', message });
    expect(events.filter((e) => e.type === 'turn_end')).toEqual([]);

    say({ type: 'agent_settled', aborted: false });
    await turn;
    expect(events).toEqual([{ type: 'assistant_text', runId: '1.1.0', text: 'Asked.' }, { type: 'turn_end' }]);
  });

  it('takes no idle check of an earlier turn for the open one\'s', async () => {
    const { adapter, events, say, turn } = await inTurn(taskStart('agent'));
    say({ id: 'turn-1', type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    say({ type: 'agent_start' });
    say({ type: 'agent_settled', aborted: false });
    await turn;
    const next: AgentEvent[] = [];
    const second = adapter.send('go on', (event) => next.push(event));
    say({ id: 'ordewell-idle-check-1', type: 'response', command: 'get_state', success: true, data: { isStreaming: false } });
    expect(next).toEqual([]);

    say({ type: 'agent_settled', aborted: false });
    await second;
    expect(events).toEqual([{ type: 'turn_end' }]);
    expect(next).toEqual([{ type: 'turn_end' }]);
  });

  it('takes no late answer to an earlier turn\'s prompt for the open one\'s', async () => {
    const { adapter, proc, say, turn } = await inTurn(taskStart('agent'));
    say({ type: 'agent_start' });
    say({ type: 'agent_settled', aborted: false });
    await turn;
    const next: AgentEvent[] = [];
    const second = adapter.send('go on', (event) => next.push(event));
    say({ id: 'turn-1', type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    say({ id: 'turn-1', type: 'response', command: 'prompt', success: false, error: 'late' });

    expect(written(proc).map((line) => line.id ?? line.type)).toEqual(['turn-1', 'turn-2']);
    expect(next).toEqual([]);
    say({ type: 'agent_settled', aborted: false });
    await second;
    expect(next).toEqual([{ type: 'turn_end' }]);
  });

  it('fails a turn whose prompt Pi refused', async () => {
    const { events, say, turn } = await inTurn(taskStart('agent'));
    say({ id: 'turn-1', type: 'response', command: 'prompt', success: false, error: 'Agent is already streaming' });
    await turn;

    expect(events).toEqual([{ type: 'error', message: 'Agent is already streaming' }]);
  });

  it('reports a compaction Pi made on its own', async () => {
    const { events, say } = await inTurn(taskStart('agent'));
    say({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000, estimatedTokensAfter: 32000 }, aborted: false, willRetry: false });
    say({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false });

    expect(events).toEqual([{ type: 'compaction', trigger: 'auto', preTokens: 150000, postTokens: 32000 }]);
  });

  it('is attached once Pi used its token, and not when it never did or had none', async () => {
    for (const [contact, state] of [[true, 'connected'], [false, 'failed']] as const) {
      const adapter = await started(silentSpawn(() => {}), taskStart('agent', { mcp: mcp({ contact: { contacted: () => contact, whenContacted: async () => contact } }) }));
      expect(await adapter.mcpAttached()).toBe(state);
    }
    const bare = await started(silentSpawn(() => {}), taskStart('agent', { mcp: mcp({ contact: undefined }) }));
    expect(await bare.mcpAttached()).toBe('failed');
  });
});

/**
 * Pi does not end its turn at `task_complete`: qwen3:8b called it 15 times in
 * one turn. Its report goes through the completion and shutdown every runner
 * has (ADR-0018 L1; ADR-0022, S3): published once at the grace with the turn
 * still open, then the turn is aborted, Pi's input ended, and the token
 * revoked, so a call after the verdict changes nothing.
 */
describe('a Pi task that keeps calling task_complete (#78)', () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !condition(); i++) await tick();
    expect(condition()).toBe(true);
  }

  it('is decided once, its turn still open, and stopped through the existing lifecycle', async () => {
    const server = new OrdewellMcpServer();
    const kit = silentSpawn((text, proc) => {
      for (const line of text.split('\n').filter(Boolean).map((raw) => JSON.parse(raw) as PiRecord)) {
        if (line.type === 'prompt') proc.emitStdout(`${JSON.stringify({ id: line.id, type: 'response', command: 'prompt', success: true })}\n${JSON.stringify({ type: 'agent_start' })}\n`);
        if (line.type === 'abort') proc.emitStdout(`${JSON.stringify({ type: 'agent_settled', aborted: true })}\n${JSON.stringify({ type: 'response', command: 'abort', success: true })}\n`);
      }
    });
    const runner = new StructuredRunner({ process: deps(kit), mcp: server, createAdapter: (_runner, processDeps) => new PiAdapter(processDeps), interruptGraceMs: 50 });
    const engine = new VerdictEngine();
    const verdicts: Verdict[] = [];
    engine.onVerdict((_id, verdict) => verdicts.push(verdict));
    const client = new Client({ name: 'pi', version: '1.5.2' });
    try {
      const spawning = runner.spawn({ taskId: 't1', runner: 'pi', prompt: 'Do it', mode: 'agent', cwd: CWD, registry: new RunnerRegistry(), attempt: 1 });
      await until(() => kit.processes.length === 1);
      // Pi connects to the server its extension registers as the session starts, which is the attach.
      const extension = [...kit.lastLaunch().files].find(([file]) => file.endsWith('ordewell.ts'))![1];
      const { url, headers } = (JSON.parse(/const CONFIG = (.*);/.exec(extension)![1]) as { server: McpClientConfig }).server;
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
      const session = await spawning;
      engine.watch(createTask({ id: 't1', title: 'Only', taskMode: 'agent' }), session);
      await until(() => written(kit.processes[0]).some((line) => line.type === 'prompt'));

      const proc = kit.processes[0];
      for (let n = 1; n <= 3; n++) {
        proc.emitStdout(`${JSON.stringify({ type: 'tool_execution_start', toolCallId: `c${n}`, toolName: 'mcp__ordewell__task_complete', args: {} })}\n`);
        const answer = await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: `Wrote it (${n}).` } });
        proc.emitStdout(`${JSON.stringify({ type: 'tool_execution_end', toolCallId: `c${n}`, toolName: 'mcp__ordewell__task_complete', result: { content: answer.content }, isError: false })}\n`);
      }
      await until(() => verdicts.length === 1);
      expect(verdicts[0]).toMatchObject({ outcome: 'pass' });
      expect(session.turnState()).toBe('working');

      // What the orchestrator does with a verdict: the attempt is over, so its session stops.
      const stopped = session.stop();
      await until(() => proc.stdinEnded);
      expect(written(proc).map((line) => line.type)).toEqual(['prompt', 'clear_queue', 'abort']);
      await expect(client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Again.' } })).rejects.toThrow();
      proc.exit(0);
      await stopped;
      expect(verdicts).toHaveLength(1);
    } finally {
      await client.close().catch(() => undefined);
      runner.stopAll();
      await server.dispose();
    }
  });
});
