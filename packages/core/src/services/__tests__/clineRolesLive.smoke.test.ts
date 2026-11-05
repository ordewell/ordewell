import { execFileSync, spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { homedir, tmpdir } from 'os';
import { basename, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnFn } from '../harness/AgentAdapter';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { OrdewellMcpServer } from '../mcp';
import { StructuredRunner } from '../StructuredRunner';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { SessionMessage } from '../SessionMessage';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { REPORT_LEAD } from '../WakePolicy';
import { fakeConfig, makeSession, taskOf } from './sessionTestKit';

/**
 * The opt-in live evidence for Cline's planner role (ADR-0060, R3): the real
 * `cline` binary through Ordewell's own planner service, session and runner,
 * each process recorded in the shape `clineCode.test.ts` replays.
 *
 *   ORDEWELL_LIVE_AGENTS=cline npx vitest run --root packages/core clineRolesLive
 *
 * One planner start is given a small goal, then asked, in the same start, to
 * write a file and run a command with Cline's own tools; the plan's read-only
 * task runs in between. Cline reaches Ordewell's MCP server over HTTP, not
 * over its stdio, so each process's settings file is pointed at a loopback
 * relay that notes what it forwards: the recording keeps that traffic as
 * `mcp` notes. The relay passes every request and answer through unchanged.
 *
 * Recordings go to ORDEWELL_LIVE_RECORD_DIR (a temporary directory unless set),
 * redacted: the workspace, the private directory, the MCP URL, the token, the
 * key, the home directory and the temporary root. Read one before committing it.
 *
 * Every workspace carries executable hooks in `.cline/hooks/` and
 * `.clinerules/hooks/` that would mark a directory outside it, so the run
 * also shows whether they ran.
 *
 * Not part of the suite: it costs real tokens and a few minutes.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('cline');
const MODEL = process.env.ORDEWELL_LIVE_MODEL ?? 'openai/gpt-4.1-mini';
const OUT = process.env.ORDEWELL_LIVE_RECORD_DIR ?? join(tmpdir(), 'ordewell-cline-roles-recordings');
const TIMEOUT_MS = 300_000;
/** The per-user segment of macOS's temporary root, which every recorded path under it carries. */
const TMP_ID = /^\/private\/var\/folders\/[^/]+\/([^/]+)\/T$/.exec(realpathSync(tmpdir()))?.[1] ?? null;
const HOOK_EVENTS = ['TaskStart', 'TaskResume', 'TaskCancel', 'TaskComplete', 'TaskError', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PreCompact', 'SessionShutdown'] as const;
const HOOK_DIRS = ['.cline/hooks', '.clinerules/hooks'] as const;
const REMINDER = 'Your turn ended without calling';

type Line = Record<string, unknown>;
interface Entry { dir: 'in' | 'out' | 'note'; ms: number; line?: unknown; event?: string; [field: string]: unknown }

const isLine = (value: unknown): value is Line => typeof value === 'object' && value !== null && !Array.isArray(value);
const asLine = (entry: Entry): Line => (isLine(entry.line) ? entry.line : {});
const paramsOf = (line: Line): Line => (isLine(line.params) ? line.params : {});

/** One `cline` process as its wire, and its traffic to Ordewell's server, showed it. */
class Recorded {
  readonly entries: Entry[] = [];
  stderr = '';
  contacted = false;
  /** What each `task_complete` call handed Ordewell. */
  readonly completed: unknown[] = [];
  /** Ordewell's tools called through the server, in order. */
  readonly calls: string[] = [];
  /** The text of each prompt the process has answered, in order. */
  readonly answered: string[] = [];
  private readonly prompts = new Map<unknown, string>();
  private readonly t0 = Date.now();
  constructor(readonly cwd: string, readonly child: ChildProcess) {}

  note(event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ dir: 'note', ms: Date.now() - this.t0, event, ...fields });
  }

  wire(dir: 'in' | 'out', text: string): void {
    let line: unknown = text;
    try { line = JSON.parse(text); } catch { /* kept as the text it was */ }
    const parsed = isLine(line) ? line : {};
    if (dir === 'out' && parsed.method === 'session/prompt') {
      if (this.prompts.size === 0) this.note('contact-before-prompt', { contacted: this.contacted });
      const prompt = paramsOf(parsed).prompt;
      const texts = Array.isArray(prompt) ? prompt.map((block) => (isLine(block) && typeof block.text === 'string' ? block.text : '')) : [];
      if (texts[0]?.startsWith(REMINDER)) this.note('completion-reminder');
      this.prompts.set(parsed.id, texts.join('\n'));
    }
    this.entries.push({ dir, ms: Date.now() - this.t0, line });
    if (dir === 'in' && parsed.method === undefined && this.prompts.has(parsed.id)) {
      const result = isLine(parsed.result) ? parsed.result : {};
      this.note('prompt-answered', { stopReason: result.stopReason ?? null, contacted: this.contacted });
      this.answered.push(this.prompts.get(parsed.id) ?? '');
    }
  }

  get exited(): boolean { return this.child.exitCode !== null || this.child.signalCode !== null; }
}

const splitLines = (buffer: string, each: (line: string) => void): string => {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) if (part.trim()) each(part);
  return rest;
};

/**
 * A loopback relay in front of Ordewell's server: it forwards each request as
 * it came, with the Host the server checks and no Origin, as Cline sends none,
 * and notes the JSON-RPC method on the process whose token it carried.
 */
class McpRelay {
  private readonly routes = new Map<string, { target: URL; recorded: Recorded }>();
  private readonly server: Server = createServer((req, res) => this.relay(req, res));
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
  }

  route(token: string, target: string, recorded: Recorded): void {
    this.routes.set(token, { target: new URL(target), recorded });
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private relay(req: IncomingMessage, res: ServerResponse): void {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const route = this.routes.get(token);
    if (!route) {
      res.writeHead(502).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const { recorded, target } = route;
      recorded.contacted = true;
      this.noteBody(recorded, req.method ?? 'GET', body);
      const headers = { ...req.headers, host: target.host };
      delete headers.origin;
      const forward = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      forward.on('error', () => res.destroy());
      forward.end(body);
    });
  }

  private noteBody(recorded: Recorded, method: string, body: Buffer): void {
    if (body.length === 0) {
      recorded.note('mcp', { method: `${method} (no body)` });
      return;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!isLine(message) || typeof message.method !== 'string') continue;
      const params = paramsOf(message);
      const tool = message.method === 'tools/call' && typeof params.name === 'string' ? params.name : undefined;
      recorded.note('mcp', { method: message.method, ...(tool ? { tool } : {}) });
      if (!tool) continue;
      recorded.calls.push(tool);
      if (tool === 'task_complete') recorded.completed.push(params.arguments);
    }
  }
}

/** The env Ordewell set for the process: what differs from its own, with any credential masked. */
function ordewellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).flatMap(([key, value]): [string, string][] => {
    // A planner's PATH is the host's, widened to find its binaries: it says
    // nothing about Cline and everything about this machine's layout.
    if (value === undefined || process.env[key] === value || key === 'PATH') return [];
    return [[key, /KEY|TOKEN|SECRET/.test(key) ? '[REDACTED]' : value]];
  }));
}

/** Ordewell's real spawn, with each `cline --acp` process's wire copied as it passes and its MCP traffic sent through the relay. */
class Tee {
  readonly processes: Recorded[] = [];
  constructor(private readonly relay: McpRelay) {}

  readonly spawn: SpawnFn = (command, args, options) => {
    if (basename(command) !== 'cline' || !args.includes('--acp')) return nodeSpawn(command, args, options);
    const settingsPath = options.env.CLINE_MCP_SETTINGS_PATH;
    const original = settingsPath ? readFileSync(settingsPath, 'utf8') : null;
    const settings: unknown = original ? JSON.parse(original) : null;
    const modes = settingsPath
      ? { settingsMode: (statSync(settingsPath).mode & 0o777).toString(8), dirMode: (statSync(options.cwd).mode & 0o777).toString(8) }
      : {};
    const child = nodeSpawn(command, args, options);
    const recorded = new Recorded(options.cwd, child);
    this.processes.push(recorded);
    recorded.note('spawn', { args, env: ordewellEnv(options.env), cwd: options.cwd, settings, ...modes });
    const server = isLine(settings) && isLine(settings.mcpServers) ? settings.mcpServers.ordewell : undefined;
    if (settingsPath && isLine(server) && typeof server.url === 'string' && isLine(server.headers)) {
      // Rewritten before Cline reads it, which it does once it is running; the
      // file keeps its owner-only mode.
      const token = String(server.headers.Authorization ?? '').replace(/^Bearer /, '');
      this.relay.route(token, server.url, recorded);
      writeFileSync(settingsPath, original!.replace(server.url, this.relay.url));
    }
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
    child.on('exit', (code, signal) => recorded.note('exit', { code, signal }));
    return child;
  };
}

/** Each path in both of its spellings, macOS's `/private` one first since it holds the other. */
const spellings = (path: string): string[] => {
  const real = existsSync(path) ? realpathSync(path) : path;
  return [...new Set([real, path, real.replace(/^\/private/, '')])].sort((a, b) => b.length - a.length);
};

function redactor(workspace: string, privateDirs: string[], markers: string): (text: string) => string {
  const pairs: [string, string][] = [
    ...privateDirs.flatMap((dir) => spellings(dir).map((s): [string, string] => [s, '{{PRIVATE_DIR}}'])),
    ...spellings(workspace).map((s): [string, string] => [s, '{{CWD}}']),
    ...spellings(markers).map((s): [string, string] => [s, '{{MARKERS}}']),
  ].sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    return out
      .replace(/http:\/\/127\.0\.0\.1:\d+\/[^"\s\\]*/g, '{{MCP_URL}}')
      .replace(/Bearer [^"\s\\]+/g, 'Bearer [REDACTED]')
      .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]')
      .split(homedir()).join('~')
      // Cline cuts a long title mid-path, where no whole path is left to find.
      .replace(/(?:\/private)?\/var\/folders\/[^"\s\\]*/g, '{{TEMP}}')
      // Whole scratch paths are gone by now, so what is left was cut short.
      .replace(/(?:\/private)?\/tmp\/ordewell-cline-[A-Za-z0-9-]*/g, '{{TEMP}}')
      .split(TMP_ID ?? '\0').join('x'.repeat(TMP_ID?.length ?? 1));
  };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const undo of cleanup.splice(0).reverse()) await undo(); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Ordewell', '-c', 'user.email=ordewell@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

/** A committed repository whose Cline hooks would each mark `markers`, outside it. */
function workspace(): { dir: string; markers: string } {
  // Under `/tmp` rather than the per-user temporary root, so a title Cline cuts short names nothing of this machine's.
  const dir = realpathSync(mkdtempSync('/tmp/ordewell-cline-'));
  const markers = realpathSync(mkdtempSync('/tmp/ordewell-cline-markers-'));
  cleanup.push(() => { rmSync(dir, { recursive: true, force: true }); rmSync(markers, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'README.md'), '# Scratch\n\nThe secret word is HERON.\n');
  for (const hookDir of HOOK_DIRS) {
    mkdirSync(join(dir, hookDir), { recursive: true });
    for (const event of HOOK_EVENTS) {
      const file = join(dir, hookDir, event);
      writeFileSync(file, `#!/bin/sh\ntouch "${markers}/${hookDir.replace(/[./]/g, '_')}-${event}"\ntouch "$PWD/planted-hook-ran.txt"\necho '{"cancel":false}'\n`);
      chmodSync(file, 0o755);
    }
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'scratch');
  return { dir, markers };
}

/** The scene's evidence of nothing written: no marker, no planted-hook file, no probe, and a clean tree. */
function untouched(dir: string, markers: string) {
  return {
    hooksRan: readdirSync(markers).sort(),
    gitStatus: git(dir, 'status', '--porcelain', '--untracked-files=all').trim(),
    found: ['planted-hook-ran.txt', 'probe.txt', 'probe-shell.txt'].filter((name) => existsSync(join(dir, name))),
  };
}

const chunkOf = (entry: Entry): { kind: string; text: string } | null => {
  const update = paramsOf(asLine(entry)).update;
  if (!isLine(update)) return null;
  const kind = update.sessionUpdate;
  const content = update.content;
  return (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') && isLine(content) && typeof content.text === 'string' && typeof kind === 'string' ? { kind, text: content.text } : null;
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
    const update = paramsOf(asLine(last)).update as Line;
    (update.content as Line).text = previous.text + chunk.text;
  }
  return out;
}

/**
 * Cline lists every model its provider offers, hundreds of them: the
 * recording keeps the first two and the current one wherever they are listed.
 */
function trimmedModels(entries: Entry[]): { entries: Entry[]; of: number; current: unknown } {
  let of = 0;
  let current: unknown = null;
  const keep = <T>(list: T[], id: (item: T) => unknown, now: unknown): T[] => list.filter((item, index) => index < 2 || id(item) === now);
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isLine(value)) return value;
    const out: Line = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    if (Array.isArray(out.availableModels)) {
      of = Math.max(of, out.availableModels.length);
      current = out.currentModelId;
      out.availableModels = keep(out.availableModels as unknown[], (m) => (isLine(m) ? m.modelId : undefined), out.currentModelId);
    }
    if (out.id === 'model' && Array.isArray(out.options)) {
      out.options = keep(out.options as unknown[], (o) => (isLine(o) ? o.value : undefined), out.currentValue);
    }
    return out;
  };
  return { entries: entries.map((entry) => (entry.dir === 'note' ? entry : { ...entry, line: walk(entry.line) })), of, current };
}

/** Each request Cline made of Ordewell, with the options it gave and the answer it got. */
function permissions(entries: Entry[]): Line[] {
  const answers = new Map<unknown, unknown>();
  for (const entry of entries) {
    const line = asLine(entry);
    if (entry.dir === 'out' && line.method === undefined && line.id !== undefined) answers.set(line.id, isLine(line.result) ? line.result.outcome : line.error);
  }
  return entries.flatMap((entry) => {
    const line = asLine(entry);
    if (entry.dir !== 'in' || line.method !== 'session/request_permission') return [];
    const params = paramsOf(line);
    const call = isLine(params.toolCall) ? params.toolCall : {};
    const options = Array.isArray(params.options) ? params.options.flatMap((o) => (isLine(o) ? [o.optionId] : [])) : [];
    return [{ title: call.title, kind: call.kind, options, answer: answers.get(line.id) ?? null }];
  });
}

/** The process ids under `pid`, so what outlives its stop is seen. */
function descendants(pid: number | undefined): number[] {
  if (pid === undefined) return [];
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number));
  const found: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const [child, ppid] of table) if (ppid === parent) { found.push(child); queue.push(child); }
  }
  return found;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

interface Stopped { privateEntries: string[]; children: number[] }

/** What each process left before its stop, read while it still ran. */
const beforeStop = (recorded: Recorded): Stopped => ({
  privateEntries: existsSync(recorded.cwd) ? readdirSync(recorded.cwd).sort() : [],
  children: descendants(recorded.child.pid),
});

function save(name: string, scene: { dir: string; markers: string }, recorded: Recorded, stopped: Stopped, privateDirs: string[]): void {
  mkdirSync(OUT, { recursive: true });
  const redact = redactor(scene.dir, privateDirs, scene.markers);
  const state = untouched(scene.dir, scene.markers);
  recorded.note('summary', {
    completed: recorded.completed,
    calls: recorded.calls,
    permissions: permissions(recorded.entries),
    hooksRan: state.hooksRan,
    leftBehind: {
      privateDirs: existsSync(recorded.cwd) ? [recorded.cwd] : [],
      clineProcesses: stopped.children.filter(alive),
    },
    worktree: { entries: readdirSync(scene.dir).sort(), gitStatus: state.gitStatus },
    privateDir: { entries: stopped.privateEntries, removed: !existsSync(recorded.cwd) },
  });
  // Cline lists the user's own slash commands, which the adapter ignores.
  const kept = recorded.entries.filter((e) => {
    const update = paramsOf(asLine(e)).update;
    return !(isLine(update) && update.sessionUpdate === 'available_commands_update');
  });
  const trimmed = trimmedModels(coalesced(kept));
  const [spawn, ...rest] = trimmed.entries;
  const entries = [spawn, { dir: 'note', ms: 0, event: 'trimmed', models: { kept: 3, of: trimmed.of, current: trimmed.current } }, ...rest];
  writeFileSync(join(OUT, `${name}.jsonl`), entries.map((e) => redact(JSON.stringify(e))).join('\n') + '\n');
  writeFileSync(join(OUT, `${name}.stderr.txt`), redact(recorded.stderr));
}

describe.runIf(live)('Cline roles — live', () => {
  it('planner: plans through Ordewell\'s tools, runs its read-only task, and has its own write and shell refused in the same start', async () => {
    const s = workspace();
    const server = new OrdewellMcpServer();
    cleanup.push(() => server.dispose());
    const relay = new McpRelay();
    await relay.start();
    cleanup.push(() => relay.stop());
    const plannerTee = new Tee(relay);
    const taskTee = new Tee(relay);

    const config = fakeConfig({ aiProvider: 'cline', orchestratorModel: MODEL });
    const ai = new CliAgentAiService(config, { spawn: plannerTee.spawn, workspaceRoot: () => s.dir, mcpServer: server });
    cleanup.push(() => ai.reset());
    const runner = new StructuredRunner({ process: { spawn: taskTee.spawn }, mcp: server });
    cleanup.push(() => runner.stopAll());
    const toolCalls: string[] = [];
    const cards: string[] = [];
    // Autorun starts a submitted plan when the reply ends (ADR-0030), so
    // nobody is asked: any card is the planner reaching past its envelope,
    // and is denied.
    const answer = (msg: SessionMessage) => {
      if (msg.type !== 'approval_request') return;
      cards.push(`${msg.kind}: ${msg.subject}`);
      setTimeout(() => session.resolveApproval(msg.id, { decision: 'deny', note: 'Not in this test.' }), 0);
    };
    const session = makeSession({
      config,
      aiService: ai,
      mcpServer: server,
      runner,
      workspaceRoot: () => s.dir,
      taskOutput: new BufferedTaskOutputSource(),
      modelResolver: { modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, r === 'cline' ? [{ modelId: MODEL, modelLabel: 'Live model', variants: [] }] : []]))) },
      settings: () => ({ enabledRunners: ['cline'], run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true } }),
      broadcast: (msg: SessionMessage) => {
        if (msg.type === 'research_step' && msg.toolLabel) toolCalls.push(msg.toolLabel);
        answer(msg);
      },
    });
    cleanup.push(() => session.destroy());

    const reply = () => session.planState?.conversationHistory?.at(-1)?.content ?? '';
    const log = (label: string) => console.log(`${label}:`, JSON.stringify(plannerTee.processes.map((p) => p.calls)), '\nreply:', reply());
    let ran: ReturnType<typeof taskOf> | undefined;
    let stops: Stopped[] = [];
    let taskStops: Stopped[] = [];
    try {
      await session.startPlanning(
        'Find out which secret word the README.md of this repository names. '
        + `Plan it as exactly one task on cline with model ${MODEL}, in its read-only mode \`plan\`, `
        + 'whose prompt asks it to read README.md and complete with the secret word as its summary.',
        ['cline'],
      );
      log('turn 1');
      if (session.planTasks.length === 0) {
        await session.continueConversation('Go ahead: call list_runners, then submit_plan with that one task.');
        log('turn 2');
      }
      console.log('committed:', JSON.stringify(session.planTasks.map((t) => [t.title, t.assignedRunner, t.assignedModel?.modelId, t.taskMode])));
      expect(session.planTasks).toHaveLength(1);
      const [task] = session.planTasks;
      await vi.waitFor(() => expect(taskOf(session, task.id)?.status).toMatch(/completed|failed|blocked/), { timeout: TIMEOUT_MS, interval: 500 });
      ran = taskOf(session, task.id);
      console.log('task:', JSON.stringify({ status: ran?.status, verdict: ran?.verdict, summary: ran?.outputSummary }));
      // The planner asked for the task's result, which reaches it in a turn of
      // its own once it is idle (ADR-0037, R2): waited for, so that turn lands
      // in this same process instead of racing the stop below.
      await vi.waitFor(() => expect(plannerTee.processes[0]?.answered.some((text) => text.includes(REPORT_LEAD))).toBe(true), { timeout: TIMEOUT_MS, interval: 500 });
      log('run update');

      // The contract tells the planner its own edits and shell are off, so a
      // model may decline to try them: each turn names the built-in tool, as
      // the read-only recordings did, since the refusal is what is observed.
      await session.continueConversation(
        'This turn tests whether your built-in file-editing tool is refused, and changes nothing in the plan. '
        + `Make exactly one call to your built-in \`apply_patch\` tool to add the file ${join(s.dir, 'probe.txt')} containing the word hello, `
        + 'made even though you expect it to be refused: the refusal is what is being observed. Do not retry it and do not try any other way of writing it, then tell me what happened.',
      );
      log('write turn');
      await session.continueConversation(
        'This turn tests whether your built-in shell tool is refused, and changes nothing in the plan. '
        + `Make exactly one call to your built-in \`run_commands\` tool with the command \`touch ${join(s.dir, 'probe-shell.txt')}\`, `
        + 'made even though you expect it to be refused: the refusal is what is being observed. A call to `ordewell__run_command` does not count and must not be made. Then tell me what happened.',
      );
      log('shell turn');
    } finally {
      stops = plannerTee.processes.map(beforeStop);
      taskStops = taskTee.processes.map(beforeStop);
      ai.reset();
      runner.stopAll();
      const all = [...plannerTee.processes, ...taskTee.processes];
      await vi.waitFor(() => expect(all.every((p) => p.exited)).toBe(true), { timeout: 20_000 }).catch(() => undefined);
      // Ordewell removes a private directory once its process is gone.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const privateDirs = all.map((p) => p.cwd);
      // A process spawned after the snapshot is recorded as it was left.
      plannerTee.processes.forEach((p, i) => save(i === 0 ? 'planner' : `planner-${i + 1}`, s, p, stops[i] ?? beforeStop(p), privateDirs));
      taskTee.processes.forEach((p, i) => save(i === 0 ? 'planner-task' : `planner-task-${i + 1}`, s, p, taskStops[i] ?? beforeStop(p), privateDirs));
      console.log('processes:', plannerTee.processes.length, taskTee.processes.length, 'state:', JSON.stringify(untouched(s.dir, s.markers)), 'cards:', cards, 'labels:', toolCalls);
      for (const p of all) console.log('permissions:', JSON.stringify(permissions(p.entries).map((q) => [q.kind, String(q.title).slice(0, 60), q.answer])));
    }

    const [planner] = plannerTee.processes;
    const [readOnly] = taskTee.processes;
    expect(planner.calls).toEqual(expect.arrayContaining(['list_runners', 'submit_plan']));
    const refused = permissions(planner.entries).flatMap((p) => (isLine(p.answer) && p.answer.optionId === 'reject_once' ? [String(p.title).split(':')[0]] : []));
    expect(refused).toEqual(expect.arrayContaining(['apply_patch', 'run_commands']));
    const [task] = session.planTasks;
    expect(task.assignedRunner).toBe('cline');
    expect(task.taskMode).toBe('plan');
    expect(readOnly.calls).toContain('task_complete');
    expect(ran?.status).toBe('completed');
    expect(ran?.verdict?.outcome).toBe('pass');
    expect(untouched(s.dir, s.markers)).toEqual({ hooksRan: [], gitStatus: '', found: [] });
    expect([...plannerTee.processes, ...taskTee.processes].every((p) => !p.cwd.startsWith(s.dir))).toBe(true);
    expect(git(s.dir, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
  }, TIMEOUT_MS * 4);
});
