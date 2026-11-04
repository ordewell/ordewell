import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { createWorktreeIsolation } from '../../GitWorktreeIsolation';
import { LeaseHost } from '../../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../../SettingsService';
import { StructuredRunner } from '../../StructuredRunner';
import { BufferedTaskOutputSource } from '../../BufferedTaskOutputSource';
import { fakeFs, fakeNotification, makeSession } from '../../__tests__/sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../../models/Task';
import { fakeConfig, patient, removeDir } from '../../../testing';
import { saveSession } from '../../../utils/sessionStore';
import { openTaskLog } from '../../../utils/taskLogStore';
import { CredentialBroker } from '../credentialBroker';
import { DockerExecutionBackend } from '../dockerLease';

/*
 * A real `codex` in a real container (ADR-0059 L7), with nothing faked but the
 * model: a Responses API on this host's loopback. So the app-server, its sandbox
 * probe, the gateway, the MCP relay and the gate all meet the real binary, whose
 * behaviour here is what the adapter's fakes were written from.
 *
 * It needs an engine and an image holding Codex, which Ordewell does not publish
 * (`docker build -t ordewell-task - < packages/core/docker/task.Dockerfile`), named
 * by ORDEWELL_E2E_CODEX_IMAGE. A task's sign-in is not here:
 * this test will not spend a person's account, and Codex takes its ChatGPT
 * backend over HTTPS alone, which a loopback fake is not.
 */

const IMAGE = process.env.ORDEWELL_E2E_CODEX_IMAGE;
const engineAnswers = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 }).status === 0;

const REQUIRED = ['fs.hostHidden', 'fs.writeScope', 'limits.memory', 'net.allowlist', 'net.noMetadata', 'cred.unreadable'];

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const dirs: string[] = [];
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-codex-container-')));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
afterEach(async () => { while (dirs.length) await removeDir(dirs.pop()!); });

function sse(res: ServerResponse, id: string, ...items: unknown[]): void {
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: null, output_tokens_details: null };
  const event = (data: { type: string }) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    event({ type: 'response.created', response: { id } } as { type: string }),
    ...items.map((item) => event({ type: 'response.output_item.done', item } as { type: string })),
    event({ type: 'response.completed', response: { id, usage } } as { type: string }),
  ].join(''));
}

/**
 * Asks for a command that writes files named for its container and records what
 * the runner's process can see, then for `task_complete`, each once, by what the
 * conversation holds, so tasks at once are told apart by their own history. Codex
 * keeps MCP tools out of its tool list: a model reaches them from `exec`.
 */
function fakeResponsesApi() {
  const heard: { path: string; authorization: unknown }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      heard.push({ path: req.url ?? '', authorization: req.headers.authorization });
      if (!req.url?.startsWith('/v1/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [], models: [] }));
        return;
      }
      if (!body.includes('call_write')) {
        const cmd = 'me=$(cat /etc/hostname); printf "written by a model turn\\n" > "wrote-$me.txt"; env | cut -d= -f1,2 > "saw-$me.txt"; pwd > "ran-$me.txt"';
        sse(res, 'resp_1', { type: 'function_call', id: 'fc_1', call_id: 'call_write', name: 'exec_command', arguments: JSON.stringify({ cmd }) });
      } else if (!body.includes('call_done')) {
        const args = { status: 'done', summary: 'Wrote it through the gateway.', commit: { subject: 'Write a file' } };
        sse(res, 'resp_2', { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_done', name: 'exec', input: `await tools.mcp__ordewell__task_complete(${JSON.stringify(args)});` });
      } else {
        sse(res, 'resp_3', { type: 'message', id: 'm_1', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] });
      }
    });
  });
  return { heard, server, listening: new Promise<string>((done) => { server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`)); }) };
}

function session(root: string, tasks: Task[], key: Record<string, string>) {
  const sessionId = `codex-e2e-${process.pid}-${tasks[0].id}`;
  const notifications = fakeNotification();
  const parent = makeSession({
    runner: new StructuredRunner(),
    taskOutput: new BufferedTaskOutputSource(),
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), noHooks: true }),
    workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId,
    config: fakeConfig({ maxParallelSessions: 2, aiProvider: 'codex', conflictRepairAttempts: 0 }),
    notifications,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    childDeps: () => ({ fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
    execution: (local, context) => new DockerExecutionBackend(local, {
      settings: { image: IMAGE, memory: '2g', login: { kind: 'broker', variables: Object.keys(key) }, required: REQUIRED },
      broker: new CredentialBroker(key),
      sessionId: context.sessionId,
      treeId: context.treeId,
      tell: context.tell,
    }),
  });
  parent.loadPlan({ tasks, runners: ['codex'], status: 'approved', generatedAt: '2026-11-02T10:00:00.000Z' } as unknown as LegacyPlanState, 'the goal', root, { sessionId });
  return { parent, notifications, integration: () => parent.planState?.isolation?.run.repos[0].integrationBranch ?? '' };
}

describe.skipIf(!engineAnswers || !IMAGE)('a Codex task in a real container', () => {
  it('takes two real Codex tasks at once through model turns at Full access, each with its own stand-in for a key that stays here, and lands both', async () => {
    const model = fakeResponsesApi();
    const url = await model.listening;
    const key = 'sk-proj-a-real-turn-through-the-gateway';
    const root = repo();
    const main = git(root, 'rev-parse', 'main');
    const tasks = ['first', 'second'].map((id, i) => createTask({ id, order: i + 1, title: `A real turn, ${id}`, prompt: 'Write the file.', assignedRunner: 'codex', taskMode: 'fullAccess' }));
    const run = session(root, tasks, { OPENAI_API_KEY: key, OPENAI_BASE_URL: url });

    await run.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => { for (const { status } of run.parent.planTasks) expect(status).not.toMatch(/approved|pending|in_progress/); }, { timeout: 200_000, interval: 200 });

    for (const done of run.parent.planTasks) {
      expect(done, JSON.stringify({ summary: done.outputSummary, heard: model.heard.map(({ path }) => path) })).toMatchObject({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } });
    }
    const integration = run.integration();
    const landed = git(root, 'ls-tree', '--name-only', integration).split('\n');
    const named = (prefix: string) => landed.filter((file) => file.startsWith(prefix)).map((file) => git(root, 'show', `${integration}:${file}`));
    expect(named('wrote-')).toEqual(['written by a model turn', 'written by a model turn']);
    for (const where of named('ran-')) expect(where).toMatch(/^\/task\/work\b/);
    expect(git(root, 'rev-parse', 'main')).toBe(main);

    const seen = named('saw-');
    expect(seen.join('\n')).not.toContain(key);
    const standIns = seen.map((env) => /OPENAI_API_KEY=(ordewell-lease-\S+)/.exec(env)?.[1]);
    expect(standIns.every(Boolean)).toBe(true);
    expect(new Set(standIns).size).toBe(2);
    expect(model.heard.length).toBeGreaterThan(0);
    for (const { authorization } of model.heard) expect(authorization).toBe(`Bearer ${key}`);
    model.server.close();
    run.parent.destroy();
  }, patient(300_000));

  it("holds a task at Codex's Guarded mode at its start, by the real sandbox's own failure, and asks the model nothing", async () => {
    const model = fakeResponsesApi();
    const url = await model.listening;
    const root = repo();
    const task = createTask({ id: 'guarded', order: 1, title: 'Guarded', prompt: 'Write the file.', assignedRunner: 'codex', taskMode: 'agent' });
    const run = session(root, [task], { OPENAI_API_KEY: 'sk-proj-never-used', OPENAI_BASE_URL: url });

    await run.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(String(vi.mocked(run.notifications.error).mock.calls[0]?.[0])).toContain("Codex cannot start its sandbox in this task's container"), { timeout: 150_000, interval: 200 });

    expect(run.parent.planTasks[0].status).toBe('pending');
    expect(model.heard.filter(({ path }) => path.startsWith('/v1/responses'))).toEqual([]);
    model.server.close();
    run.parent.destroy();
  }, patient(240_000));
});
