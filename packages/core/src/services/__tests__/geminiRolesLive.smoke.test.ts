import { execFile, execFileSync, spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnFn } from '../harness/AgentAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { SessionMessage } from '../SessionMessage';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { BaseFileSystem } from '../BaseFileSystem';
import type { ShellLaunch } from '../researchShell';
import type { ToolOutcome } from '../../interfaces/IFileSystem';
import { fakeConfig, makeSession, taskOf } from './sessionTestKit';

/**
 * The opt-in live evidence for Gemini CLI's planner and read-only roles
 * (ADR-0060, R3): the real `gemini` binary through Ordewell's own spawn,
 * adapter, runner and planner service, each process recorded as the fixtures
 * `geminiCli.test.ts` replays.
 *
 *   ORDEWELL_LIVE_AGENTS=gemini-cli npx vitest run --root packages/core geminiRolesLive
 *
 * Recordings go to ORDEWELL_LIVE_RECORD_DIR (a temporary directory unless set),
 * redacted: the workspace, the private directory, the MCP URL, the token, the
 * home directory and the temporary root. Read one before committing it.
 *
 * Every workspace carries a `.gemini/settings.json` whose hooks would mark a
 * directory outside it, so each scenario also shows whether they ran; a
 * writable start in the same kind of workspace shows they do run there.
 *
 * Not part of the suite: it costs real tokens and a few minutes.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('gemini-cli');
const MODEL = process.env.ORDEWELL_LIVE_MODEL ?? 'gemini-3.8-flash';
const OUT = process.env.ORDEWELL_LIVE_RECORD_DIR ?? join(tmpdir(), 'ordewell-gemini-roles-recordings');
const TIMEOUT_MS = 300_000;
/** The per-user segment of macOS's temporary root, which every recorded path under it carries. */
const TMP_ID = /^\/private\/var\/folders\/[^/]+\/([^/]+)\/T$/.exec(realpathSync(tmpdir()))?.[1] ?? null;
const HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeModel', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd'] as const;
/** Gemini names Ordewell's tools `mcp_ordewell_<tool>`, and a call id is that name, `__`, and a counter. */
const ORDEWELL_PREFIX = 'mcp_ordewell_';

/**
 * The shell a host gives the planner's `run_command` and a read-only task's
 * (ADR-0046), as the adapters run it. From its private directory Gemini's own
 * read tools reach nothing of the workspace, so this is the only way either
 * role reads it, as it is in a real session; the test kit's fake shell
 * answers nothing.
 */
class HostFileSystem extends BaseFileSystem {
  constructor(private readonly root: string) { super(); }

  getWorkspaceRoot(): string { return this.root; }
  // The planner's start reads its context files and lists the workspace; no
  // Gemini tool reaches these, so they answer as plainly as the shell would.
  protected async readFileImpl(absPath: string): Promise<ToolOutcome> {
    return existsSync(absPath) ? { success: true, output: readFileSync(absPath, 'utf8'), truncated: false } : { success: false, output: `${absPath}: no such file`, truncated: false };
  }
  protected async listDirImpl(absPath: string): Promise<ToolOutcome> {
    return { success: true, output: readdirSync(absPath).join('\n'), truncated: false };
  }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }

  protected execBashImpl(command: string, shell: ShellLaunch, _signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome> {
    return new Promise((resolve) => {
      execFile(shell.file ?? '/bin/sh', [...shell.args, command], {
        cwd, env: shell.env, timeout: shell.wallTimeMs ?? 60_000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        resolve({ success: !err, output: `${stdout}${stderr}`, truncated: false });
      });
    });
  }
}

interface Entry { dir: 'in' | 'out' | 'note'; ms: number; line?: unknown; event?: string; [field: string]: unknown }

/** One `gemini` process as its wire showed it. */
class Recorded {
  readonly entries: Entry[] = [];
  stderr = '';
  private readonly t0 = Date.now();
  constructor(readonly cwd: string, readonly child: ChildProcess) {}

  note(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ dir: 'note', ms: Date.now() - this.t0, event, ...fields });
  }

  wire(dir: 'in' | 'out', text: string): void {
    let line: unknown = text;
    try { line = JSON.parse(text); } catch { /* kept as the text it was */ }
    this.entries.push({ dir, ms: Date.now() - this.t0, line });
  }

  get exited(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }
}

const splitLines = (buffer: string, each: (line: string) => void): string => {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) if (part.trim()) each(part);
  return rest;
};

/** Ordewell's real spawn, with each `gemini` process's stdin and stdout copied as they pass. */
class Tee {
  readonly processes: Recorded[] = [];

  readonly spawn: SpawnFn = (command, args, options) => {
    const child = nodeSpawn(command, args, options);
    if (basename(command) !== 'gemini') return child;
    const recorded = new Recorded(options.cwd, child);
    this.processes.push(recorded);
    recorded.note('spawn', { args, cwd: options.cwd, tmpdir: options.env.TMPDIR ?? null, startDirAtSpawn: readdirSync(options.cwd).sort() });
    const stdin = child.stdin;
    if (stdin) {
      let pending = '';
      const write = stdin.write.bind(stdin) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
      Object.assign(stdin, {
        write: (chunk: string | Uint8Array, ...rest: unknown[]) => {
          pending = splitLines(pending + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')), (l) => recorded.wire('out', l));
          return write(chunk, ...rest);
        },
      });
    }
    let incoming = '';
    child.stdout?.on('data', (data: Buffer) => { incoming = splitLines(incoming + data.toString('utf8'), (l) => recorded.wire('in', l)); });
    child.stderr?.on('data', (data: Buffer) => { recorded.stderr += data.toString('utf8'); });
    return child;
  };
}

/** Each path in both of its spellings, macOS's `/private` one first since it holds the other. */
const spellings = (path: string): string[] => {
  const real = existsSync(path) ? realpathSync(path) : path;
  return [...new Set([real, path, real.replace(/^\/private/, '')])].sort((a, b) => b.length - a.length);
};

function redactor(workspace: string, startDirs: string[]): (text: string) => string {
  const pairs: [string, string][] = [
    ...startDirs.flatMap((dir) => spellings(dir).map((s): [string, string] => [s, '{{START_DIR}}'])),
    ...spellings(workspace).map((s): [string, string] => [s, '{{CWD}}']),
  ].sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out
      .replace(/http:\/\/127\.0\.0\.1:\d+\/[^"\s\\]*/g, '{{MCP_URL}}')
      .replace(/Bearer [^"\s\\]+/g, 'Bearer [REDACTED]')
      .replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
      .split(homedir()).join('~')
      // Any other temp path still names this machine's temp directory.
      .split(TMP_ID ?? '\0').join('x'.repeat(TMP_ID?.length ?? 1));
  };
}

type Line = Record<string, unknown>;
const asLine = (entry: Entry): Line => (typeof entry.line === 'object' && entry.line !== null ? entry.line as Line : {});
const paramsOf = (line: Line): Line => (typeof line.params === 'object' && line.params !== null ? line.params as Line : {});
const ordewellToolOf = (call: Line | undefined): string | undefined => {
  const id = call?.toolCallId;
  if (typeof id !== 'string') return undefined;
  const name = id.slice(0, Math.max(0, id.indexOf('__')));
  return name.startsWith(ORDEWELL_PREFIX) ? name.slice(ORDEWELL_PREFIX.length) : undefined;
};

/** The note a fixture ends with: what Gemini called of Ordewell's, what it asked and how it was answered, what failed, and what was left. */
function summary(recorded: Recorded, leftBehind: string[], hooksRan: string[], handed: Handed[] = []): Line {
  const calls: string[] = [];
  const counted = new Set<string>();
  const permissions: Line[] = [];
  const failed: Line[] = [];
  const answers = new Map<unknown, unknown>();
  for (const entry of recorded.entries) {
    const line = asLine(entry);
    if (entry.dir === 'out' && line.method === undefined && line.id !== undefined) answers.set(line.id, line.result);
  }
  for (const entry of recorded.entries) {
    if (entry.dir !== 'in') continue;
    const line = asLine(entry);
    const params = paramsOf(line);
    const call = (line.method === 'session/request_permission' ? params.toolCall : (params.update as Line | undefined)) as Line | undefined;
    const tool = ordewellToolOf(call);
    const id = call?.toolCallId as string | undefined;
    if (tool && id && !counted.has(id)) {
      counted.add(id);
      calls.push(tool);
    }
    if (line.method === 'session/request_permission') {
      const answer = answers.get(line.id) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
      const options = (params.options as { optionId: string; kind: string }[] | undefined) ?? [];
      const chosen = options.find((o) => o.optionId === answer?.outcome?.optionId);
      permissions.push({ toolCallId: id, kind: call?.kind, answered: chosen?.kind ?? answer?.outcome?.outcome ?? null });
    }
    if (call?.status === 'failed') failed.push({ toolCallId: id, kind: call.kind });
  }
  return { calls, permissions, failed, handed, leftBehind, hooksRan };
}

/** One call Ordewell's server answered, with the arguments it was handed. */
interface Handed { tool: string; args: unknown }

/**
 * `server`, keeping the arguments of each call it answers under the role of
 * the token it came by. Gemini's requests carry no input, and its titles are
 * the model's words, so the server is the only place a replay finds them.
 */
function handing(server: OrdewellMcpServer): Record<'task' | 'planner', Handed[]> {
  const handed: Record<'task' | 'planner', Handed[]> = { task: [], planner: [] };
  const kept = <H extends object>(role: 'task' | 'planner', handler: H): H => new Proxy(handler, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || typeof key !== 'string') return value;
      const tool = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
      return (args: unknown, ...rest: unknown[]) => {
        handed[role].push({ tool, args });
        return Reflect.apply(value, target, [args, ...rest]) as unknown;
      };
    },
  });
  const task = server.issueTaskToken.bind(server);
  const planner = server.issuePlannerToken.bind(server);
  server.issueTaskToken = (scope, handler = {}) => task(scope, kept('task', handler));
  server.issuePlannerToken = (scope, handler = {}) => planner(scope, kept('planner', handler));
  return handed;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const undo of cleanup.splice(0).reverse()) await undo(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Ordewell', '-c', 'user.email=ordewell@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/**
 * A committed repository whose `.gemini/settings.json` hooks would each mark
 * `markers`, outside it, and drop a file in it. The path is absolute: Gemini
 * hands a hook the `PWD` of whoever started it, so a hook's `$PWD` was
 * recorded naming Ordewell's own directory, not the workspace.
 */
function workspace(): { dir: string; markers: string; settingsHash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-gemini-roles-'));
  const markers = mkdtempSync(join(tmpdir(), 'ordewell-gemini-markers-'));
  cleanup.push(() => { rmSync(dir, { recursive: true, force: true }); rmSync(markers, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'README.md'), '# Scratch\n\nThe secret word is HERON.\n');
  mkdirSync(join(dir, '.gemini'));
  const hook = (event: string) => [{ hooks: [{ type: 'command', command: `touch "${markers}/${event}"; touch "${dir}/planted-hook-ran.txt"; echo '{}'` }] }];
  const settings = JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, hook(event)])) }, null, 2);
  writeFileSync(join(dir, '.gemini', 'settings.json'), settings);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'scratch');
  return { dir, markers, settingsHash: createHash('sha256').update(settings).digest('hex') };
}

interface Scene { dir: string; markers: string; settingsHash: string; tee: Tee; server: OrdewellMcpServer; handed: Record<'task' | 'planner', Handed[]> }

function scene(): Scene {
  const server = new OrdewellMcpServer();
  cleanup.push(() => server.dispose());
  return { ...workspace(), tee: new Tee(), server, handed: handing(server) };
}

/** The scene's evidence of nothing written: no marker, no planted-hook file, the settings as they were, and a clean tree. */
function untouched(scene: Scene, extra: string[] = []) {
  const settings = readFileSync(join(scene.dir, '.gemini', 'settings.json'));
  return {
    hooksRan: readdirSync(scene.markers).sort(),
    settingsUnchanged: createHash('sha256').update(settings).digest('hex') === scene.settingsHash,
    gitStatus: git(scene.dir, 'status', '--porcelain', '--untracked-files=all').trim(),
    found: ['planted-hook-ran.txt', ...extra].filter((name) => existsSync(join(scene.dir, name))),
  };
}

const chunkOf = (entry: Entry): { kind: string; text: string } | null => {
  const update = paramsOf(asLine(entry)).update as Line | undefined;
  const kind = update?.sessionUpdate;
  const content = update?.content as Line | undefined;
  return (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && typeof content?.text === 'string' ? { kind, text: content.text } : null;
};

/**
 * A run of one kind of text chunk as the one chunk it adds up to: the model
 * streams a path across chunks, where no redaction would find it whole.
 */
function coalesced(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const entry of entries) {
    const chunk = chunkOf(entry);
    const last = out.at(-1);
    const previous = last ? chunkOf(last) : null;
    if (!chunk || !last || previous?.kind !== chunk.kind || last.dir !== entry.dir) {
      out.push(chunk ? structuredClone(entry) : entry);
      continue;
    }
    ((paramsOf(asLine(last)).update as Line).content as Line).text = previous.text + chunk.text;
  }
  return out;
}

function save(name: string, scene: Scene, recorded: Recorded, leftBehind: string[], hooksRan: string[], role: 'task' | 'planner' = 'task'): void {
  mkdirSync(OUT, { recursive: true });
  const redact = redactor(scene.dir, scene.tee.processes.map((p) => p.cwd));
  recorded.note('summary', summary(recorded, leftBehind, hooksRan, scene.handed[role]));
  // The slash commands Gemini lists are the user's own; the adapter ignores
  // them, as the earlier fixtures leave them out.
  const kept = recorded.entries.filter((e) => (paramsOf(asLine(e)).update as Line | undefined)?.sessionUpdate !== 'available_commands_update');
  writeFileSync(join(OUT, `${name}.jsonl`), coalesced(kept).map((e) => redact(JSON.stringify(e))).join('\n') + '\n');
  writeFileSync(join(OUT, `${name}.stderr.txt`), redact(recorded.stderr));
}

/** A task straight on Ordewell's runner: Ordewell's `plan` mode is the profile's read-only one, `default` a writable one. */
async function task(scene: Scene, prompt: string, mode: 'plan' | 'default' = 'plan') {
  const runner = new StructuredRunner({ process: { spawn: scene.tee.spawn }, mcp: scene.server });
  cleanup.push(() => runner.stopAll());
  const session = await runner.spawn({
    taskId: 'gemini-live', runner: 'gemini-cli', prompt, modelId: MODEL, mode,
    cwd: scene.dir, workspaceRoot: scene.dir, registry: new RunnerRegistry(), attempt: 1, planSessionId: 'live',
  });
  const events: StructuredEvent[] = [];
  const ends: StructuredTurnEnd[] = [];
  const reports: { status: string; summary?: string }[] = [];
  session.onEvent((e) => events.push(e));
  session.onTurnEnd((reason) => ends.push(reason));
  session.onTaskComplete((completion) => reports.push(completion));
  await vi.waitFor(() => expect(ends.length).toBeGreaterThan(0), { timeout: TIMEOUT_MS, interval: 500 });
  return { runner, session, events, ends, reports, recorded: scene.tee.processes[0] };
}

/** The text of each failed update to a call of Gemini's own `tool`, whose call ids begin with its bare name. */
const refusals = (recorded: Recorded, tool: string): string[] => recorded.entries.flatMap((entry) => {
  const update = paramsOf(asLine(entry)).update as Line | undefined;
  if (entry.dir !== 'in' || update?.sessionUpdate !== 'tool_call_update' || update.status !== 'failed') return [];
  if (!String(update.toolCallId).startsWith(`${tool}__`)) return [];
  const content = (update.content as { content?: { text?: unknown } }[] | undefined) ?? [];
  return [content.map((c) => String(c.content?.text ?? '')).join('\n')];
});

/**
 * The hook scenarios' one prompt, so the writable control and the restricted
 * start differ only in their mode. A task on the runner alone has no
 * `run_command` wired, and from its private directory Gemini's own read tools
 * reach nothing of the workspace, so reading the repository is left to the
 * planner scenario, whose task the orchestrator gives a shell.
 */
const AT_ONCE = 'Complete the task through Ordewell at once, with status "done" and the summary "ok". Do nothing else.';

const requests = (events: StructuredEvent[]) => events.flatMap((e) => (e.type === 'permission_request' ? [e] : []));
const failures = (events: StructuredEvent[]) => events.flatMap((e) => (e.type === 'tool_result' && !e.success ? [String(e.output ?? '')] : []));

describe.runIf(live)('Gemini CLI roles — live', () => {
  it.each([
    ['restricted-write', 'write_file', ['probe.txt'], 'Use your own write_file tool exactly once to create the file probe.txt in your current working directory, containing the word hello. Do not retry it and do not try any other way of writing it.'],
    ['restricted-shell', 'run_shell_command', ['probe-shell.txt'], 'Use your own run_shell_command tool exactly once to run `touch probe-shell.txt` in your current working directory. Do not retry it and do not try any other way of running it.'],
    ['restricted-safe-shell', 'run_shell_command', [], 'Use your own run_shell_command tool exactly once to run `echo probe`. Do not retry it and do not try any other way of running it.'],
    ['restricted-web', 'google_web_search', [], 'Use your own google_web_search tool exactly once to search for "Agent Client Protocol". Do not retry it and do not try any other way of searching.'],
  ] as const)('%s: Gemini refuses its own %s and leaves nothing behind', async (name, tool, files, ask) => {
    const s = scene();
    const prompt = `This is a test of a sandbox. ${ask} Whatever happens, then complete the task through Ordewell: status "blocked" if it was refused, "done" if it worked, and a one-line summary of what happened.`;
    const run = await task(s, prompt);
    const recorded = run.recorded;
    const inPrivate = [...files, 'planted-hook-ran.txt'].filter((f) => existsSync(join(recorded.cwd, f)));
    const state = untouched(s, [...files]);
    run.runner.stopAll();
    await vi.waitFor(() => expect(recorded.exited).toBe(true), { timeout: 20_000 });
    save(name, s, recorded, [...state.found, ...inPrivate.map((f) => `{{START_DIR}}/${f}`)], state.hooksRan);

    const seen = summary(recorded, [], []);
    console.log(name, JSON.stringify({ asked: requests(run.events).map((e) => [e.name, e.decided]), failures: failures(run.events), seen, reports: run.reports, ends: run.ends, state, inPrivate }, null, 1));
    // Gemini's own refusal, not the model's account of one: the call failed
    // with its policy's words.
    const refused = refusals(recorded, tool);
    expect(refused).not.toEqual([]);
    expect(refused.filter((text) => !/denied by policy/.test(text))).toEqual([]);
    // Nothing of Gemini's own ran: every request but Ordewell's was refused.
    expect((seen.permissions as Line[]).filter((p) => !String(p.toolCallId).startsWith(ORDEWELL_PREFIX) && p.answered !== 'reject_once')).toEqual([]);
    expect(state).toEqual({ hooksRan: [], settingsUnchanged: true, gitStatus: '', found: [] });
    expect(inPrivate).toEqual([]);
  }, TIMEOUT_MS * 2);

  it('planted-hook control: a writable start in the worktree runs the workspace\'s hooks', async () => {
    const s = scene();
    const run = await task(s, AT_ONCE, 'default');
    const state = untouched(s);
    run.runner.stopAll();
    await vi.waitFor(() => expect(run.recorded.exited).toBe(true), { timeout: 20_000 });
    console.log('planted-hook control', JSON.stringify({ reports: run.reports, state, cwd: run.recorded.cwd === s.dir }, null, 1));
    // Over ACP Gemini was recorded running no SessionStart hook, so the turn's own hooks are the evidence.
    expect(state.hooksRan).toEqual(expect.arrayContaining(['BeforeAgent', 'BeforeModel']));
    expect(state.found).toContain('planted-hook-ran.txt');
  }, TIMEOUT_MS * 2);

  it('planted-hook: runs none of the workspace\'s hooks, and leaves its settings as they were', async () => {
    const s = scene();
    const run = await task(s, AT_ONCE);
    const recorded = run.recorded;
    const inPrivate = ['planted-hook-ran.txt'].filter((f) => existsSync(join(recorded.cwd, f)));
    const state = untouched(s);
    run.runner.stopAll();
    await vi.waitFor(() => expect(recorded.exited).toBe(true), { timeout: 20_000 });
    save('planted-hook', s, recorded, [...state.found, ...inPrivate], state.hooksRan);

    console.log('planted-hook', JSON.stringify({ asked: requests(run.events).map((e) => [e.name, e.decided]), seen: summary(recorded, [], []), reports: run.reports, ends: run.ends, state, inPrivate }, null, 1));
    expect(state).toEqual({ hooksRan: [], settingsUnchanged: true, gitStatus: '', found: [] });
    expect(inPrivate).toEqual([]);
    expect(run.reports).toEqual([expect.objectContaining({ status: 'done' })]);
  }, TIMEOUT_MS * 2);

  it('planner and read-only: plans through Ordewell\'s tools, runs the plan, and its read-only task lands nothing', async () => {
    const s = scene();
    const config = fakeConfig({ aiProvider: 'gemini-cli', orchestratorModel: MODEL });
    const ai = new CliAgentAiService(config, { spawn: s.tee.spawn, workspaceRoot: () => s.dir, mcpServer: s.server });
    cleanup.push(() => ai.reset());
    const runner = new StructuredRunner({ process: { spawn: s.tee.spawn }, mcp: s.server });
    cleanup.push(() => runner.stopAll());
    const toolCalls: string[] = [];
    const cards: string[] = [];
    // Full with autorun lets the planner's own run_plan start the plan
    // (ADR-0030), so nobody is asked: any card is the planner reaching past its
    // envelope, and is denied.
    const answer = (msg: SessionMessage) => {
      if (msg.type !== 'approval_request') return;
      cards.push(`${msg.kind}: ${msg.subject}`);
      setTimeout(() => session.resolveApproval(msg.id, { decision: 'deny', note: 'Not in this test.' }), 0);
    };
    const session = makeSession({
      config,
      aiService: ai,
      mcpServer: s.server,
      runner,
      workspaceRoot: () => s.dir,
      fsAdapter: new HostFileSystem(s.dir),
      taskOutput: new BufferedTaskOutputSource(),
      modelResolver: { modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, r === 'gemini-cli' ? [{ modelId: MODEL, modelLabel: 'Live model', variants: [] }] : []]))) },
      settings: () => ({ enabledRunners: ['gemini-cli'], run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true } }),
      broadcast: (msg: SessionMessage) => {
        if (msg.type === 'research_step' && msg.toolLabel) toolCalls.push(msg.toolLabel);
        answer(msg);
      },
    });
    cleanup.push(() => session.destroy());

    const reply = () => session.planState?.conversationHistory?.at(-1)?.content ?? '';
    let ran: ReturnType<typeof taskOf> | undefined;
    try {
      await session.startPlanning(
        'This is a test of the planning tools in a scratch repository: do not read, search or explore anything, and do not check that the file exists. '
        + `Call list_runners and list_models, then submit a plan of exactly one AFK ai task on gemini-cli with model ${MODEL}, `
        + 'in its read-only mode `plan`, titled "Read the README", whose prompt is: read the repository\'s README.md by running `cat README.md` with run_command, and complete with the secret word it names as the summary. '
        + 'Submit it, then start it with run_plan, without asking me anything.',
        ['gemini-cli'],
      );
      console.log('turn 1:', toolCalls.join(', '), '\nreply:', reply());
      if (session.planTasks.length === 0) {
        await session.continueConversation('Go ahead: call list_runners and list_models now, then submit_plan, then run_plan.');
        console.log('turn 2:', toolCalls.join(', '), '\nreply:', reply());
      }
      console.log('committed:', JSON.stringify(session.planTasks.map((t) => [t.title, t.assignedRunner, t.assignedModel?.modelId, t.taskMode])));
      expect(session.planTasks).toHaveLength(1);
      const [planned] = session.planTasks;
      expect(planned.assignedRunner).toBe('gemini-cli');
      expect(planned.taskMode).toBe('plan');
      console.log('cards:', cards);
      await vi.waitFor(() => expect(taskOf(session, planned.id)?.status).toMatch(/completed|failed|blocked/), { timeout: TIMEOUT_MS, interval: 500 });
      ran = taskOf(session, planned.id);
      console.log('task:', JSON.stringify({ status: ran?.status, verdict: ran?.verdict, summary: ran?.outputSummary, handoff: ran?.handoff }));
    } finally {
      const state = untouched(s);
      ai.reset();
      runner.stopAll();
      await vi.waitFor(() => expect(s.tee.processes.every((p) => p.exited)).toBe(true), { timeout: 20_000 }).catch(() => undefined);
      const [planner, readOnly] = s.tee.processes;
      if (planner) save('planner', s, planner, state.found, state.hooksRan, 'planner');
      if (readOnly) save('read-only', s, readOnly, state.found, state.hooksRan);
      console.log('processes:', s.tee.processes.length, 'state:', JSON.stringify(state));
      for (const p of s.tee.processes) console.log('calls:', JSON.stringify(summary(p, [], []).calls), 'cwd outside:', !p.cwd.startsWith(s.dir));
      expect(state).toEqual({ hooksRan: [], settingsUnchanged: true, gitStatus: '', found: [] });
    }
    const [planner, readOnly] = s.tee.processes;
    expect(summary(planner, [], []).calls).toEqual(expect.arrayContaining(['list_runners', 'submit_plan', 'run_plan']));
    expect(summary(readOnly, [], []).calls).toContain('task_complete');
    expect(cards).toEqual([]);
    expect([planner.cwd, readOnly.cwd].some((dir) => dir.startsWith(s.dir))).toBe(false);
    expect(ran?.status).toBe('completed');
    expect(ran?.verdict?.outcome).toBe('pass');
    // The word is only in the workspace's README, which the task reached through Ordewell's shell.
    expect(ran?.handoff?.summary).toContain('HERON');
    expect(git(s.dir, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  }, TIMEOUT_MS * 3);
});
