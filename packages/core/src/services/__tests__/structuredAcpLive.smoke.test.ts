import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerEntry, RunnerManifest } from '../../plugins/types';
import type { IRunnerSession, StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';
import { VerdictEngine } from '../VerdictEngine';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask, type Verdict } from '../../models/Task';
import { AcpAdapter } from '../harness/AcpAdapter';
import type { AcpProfile } from '../harness/acpProfiles';
import { createTaskAdapter } from '../harness/connectors';
import { ORDEWELL_MCP_SERVER_NAME } from '../mcp/clientConfig';

/**
 * The opt-in live check for the ACP connector on the structured transport
 * (ADR-0018), gated like `structuredOpenCodeLive.smoke.test.ts` and for the
 * same reasons: real quota, real latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=copilot-cli,opencode-acp npx vitest run --root packages/core structuredAcpLive
 *
 * Two agents behind the one adapter: Copilot CLI, the reference runner, as
 * the product wires it, and `opencode acp` as a second implementation of the
 * protocol through a profile that lives only here. OpenCode keeps its native
 * connector in the product; this profile exists so that a behaviour these
 * tests pin is ACP's and not one agent's.
 */

const requested = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim());
const TIMEOUT_MS = 240_000;

/**
 * Not the product's opencode manifest: there `build` approves everything,
 * so nothing would ever reach a person. `default` here leaves each request
 * to whoever answers, which is the case the permission test needs.
 */
const OPENCODE_ACP_MANIFEST: RunnerManifest = {
  name: 'opencode-acp',
  displayName: 'OpenCode (ACP)',
  runner: { command: 'opencode' },
  features: { modeSettings: { approvals: { auto: 'auto' } } },
  modelDiscovery: { method: 'command' },
  modes: [
    { id: 'default', label: 'Ask', description: 'Requests wait for an answer', safe: true },
    { id: 'auto', label: 'Auto', description: 'Ordewell approves every request', autonomous: true },
  ],
};

const OPENCODE_SERVER_PREFIX = `${ORDEWELL_MCP_SERVER_NAME}_`;

/**
 * Test-only. OpenCode 2.x calls MCP tools from inside its `execute` code
 * tool, so a call is seldom reported under the tool's own name; only a
 * direct one is read as Ordewell's. It writes without asking, so it claims
 * no role.
 */
const OPENCODE_ACP_PROFILE: AcpProfile = {
  manifest: OPENCODE_ACP_MANIFEST,
  args: ['acp'],
  // OpenCode asks nothing by default, not even for a write outside its
  // directory, so its shell is set to ask: without it no request would reach
  // Ordewell for the permission test to answer, nor for `auto` to approve.
  env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: 'ask' } }) },
  instructions: { kind: 'prompt' },
  ordewellTool: ({ request, report }) => {
    const call = report ?? request;
    return call.kind === 'other' && call.title?.startsWith(OPENCODE_SERVER_PREFIX) ? call.title.slice(OPENCODE_SERVER_PREFIX.length) : null;
  },
  toolName: (tool) => `${OPENCODE_SERVER_PREFIX}${tool}`,
};

class LiveRegistry extends RunnerRegistry {
  override get(id: string): RunnerEntry | undefined {
    return id === OPENCODE_ACP_MANIFEST.name ? { manifest: OPENCODE_ACP_MANIFEST } : super.get(id);
  }
}

interface Target {
  runner: 'copilot-cli' | 'opencode-acp';
  /** Copilot's model reaches it as `--model`; OpenCode's through its model option, since its default model fails. */
  model: string;
  /** The mode that asks nobody, for the turns that run commands. */
  auto: string;
  shell: string;
  /**
   * How the turn ends once its one request is denied. Copilot carries on and
   * finishes the turn; OpenCode answers the prompt with `cancelled`, which
   * Ordewell reads as the stop it is, an interrupted turn.
   */
  afterDeny: StructuredTurnEnd;
}

const TARGETS: Target[] = [
  { runner: 'copilot-cli', model: process.env.ORDEWELL_LIVE_MODEL ?? 'gpt-5-mini', auto: 'allowAll', shell: 'shell', afterDeny: 'completed' },
  { runner: 'opencode-acp', model: process.env.ORDEWELL_LIVE_MODEL ?? 'opencode-go/deepseek-v4.1-flash', auto: 'auto', shell: 'shell', afterDeny: 'interrupted' },
];

function harness(target: Target) {
  const runner = new StructuredRunner({
    createAdapter: (id, deps) => (id === OPENCODE_ACP_MANIFEST.name ? new AcpAdapter(deps, OPENCODE_ACP_PROFILE) : createTaskAdapter(id, deps)),
  });
  const registry = new LiveRegistry();
  const spawn = async (taskId: string, dir: string, prompt: string, mode: string, resumeSessionId?: string) => {
    const session = await runner.spawn({
      taskId,
      runner: target.runner,
      prompt,
      modelId: target.model,
      mode,
      cwd: dir,
      registry,
      attempt: 1,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    const ends: StructuredTurnEnd[] = [];
    const reports: string[] = [];
    const events: StructuredEvent[] = [];
    let waiter: (() => void) | null = null;
    session.onTaskComplete(({ status }) => reports.push(status));
    session.onTurnEnd((reason) => { ends.push(reason); waiter?.(); waiter = null; });
    session.onEvent((e) => events.push(e));
    const next = () => new Promise<void>((resolve) => { waiter = resolve; });
    return { session, ends, reports, events, next };
  };
  return { runner, spawn };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ordewell-structured-acp-'));
}

function openRequests(events: StructuredEvent[]) {
  return events.filter((e): e is Extract<StructuredEvent, { type: 'permission_request' }> => e.type === 'permission_request' && !e.decided);
}

const ranCommand = (events: StructuredEvent[], text: string) =>
  events.some((e) => e.type === 'tool_call' && JSON.stringify(e.args).includes(text));

async function untilEnds(turns: { ends: StructuredTurnEnd[]; next(): Promise<void> }, count: number): Promise<void> {
  while (turns.ends.length < count) await turns.next();
}

function describeTarget(target: Target, session: IRunnerSession): string {
  return `${target.runner} on ${target.model}:\n${session.getOutput()}`;
}

for (const target of TARGETS) {
  describe.runIf(requested.includes(target.runner))(`structured transport — ${target.runner} over ACP, live smoke`, () => {
    it('ends a task turn in task_complete, with Ordewell\'s tool answered by nobody', async () => {
      const dir = scratch();
      const { runner, spawn } = harness(target);
      const task = createTask({ id: `${target.runner}-complete`, title: 'Multiply', prompt: 'Work out 17 * 23 and state the result. Use no tool except task_complete.' });
      const engine = new VerdictEngine();
      const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
      try {
        const turns = await spawn(task.id, dir, composeAugmentedPrompt(task, [task], {}), 'default');
        engine.watch(task, turns.session);

        const decided = await verdict;
        expect(decided.outcome, describeTarget(target, turns.session)).toBe('pass');
        expect(decided.checks[0].name).toBe('task_complete');
        await untilEnds(turns, 1);
        expect(turns.ends).toEqual(['completed']);
        expect(turns.reports).toEqual(['done']);
        expect(openRequests(turns.events), describeTarget(target, turns.session)).toEqual([]);
        expect(turns.session.getOutput()).toContain('391');
      } finally {
        runner.stopAll();
        rmSync(dir, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);

    it('interrupts a running command and keeps the session for the next message', async () => {
      const dir = scratch();
      const { runner, spawn } = harness(target);
      try {
        const turns = await spawn(`${target.runner}-interrupt`, dir,
          `Use your ${target.shell} tool to run \`sleep 60 && touch slept.txt\`. Then summarize the result.`, target.auto);
        await vi.waitFor(() => expect(ranCommand(turns.events, 'sleep 60'), describeTarget(target, turns.session)).toBe(true), { timeout: 90_000, interval: 250 });

        const started = Date.now();
        await turns.session.interrupt();
        console.error(`[live] ${target.runner} interrupt: ${Date.now() - started}ms to the turn's end`);
        expect(turns.ends).toEqual(['interrupted']);
        expect(turns.session.turnState()).toBe('idle');

        // Copilot has taken an open-ended follow-up as leave to finish the
        // interrupted work, sleep included, which would fail the check below
        // on the model's choice and not the interrupt's.
        turns.session.sendMessage('Stop the earlier work and run no tool or command. Reply with only the word: ok');
        await untilEnds(turns, 2);
        expect(turns.ends, describeTarget(target, turns.session)).toEqual(['interrupted', 'completed']);
        expect(turns.session.getOutput().toLowerCase()).toContain('ok');
        const calls = turns.events.filter((e) => e.type === 'tool_call');
        expect(existsSync(join(dir, 'slept.txt')), `${describeTarget(target, turns.session)}\n${JSON.stringify(calls)}`).toBe(false);
      } finally {
        runner.stopAll();
        rmSync(dir, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);

    it('holds a message sent during a turn until the turn ends, then sends it unasked', async () => {
      const dir = scratch();
      const { runner, spawn } = harness(target);
      try {
        const turns = await spawn(`${target.runner}-queue`, dir,
          `Use your ${target.shell} tool to run \`sleep 15\`. Then reply with one short sentence saying what you ran.`, target.auto);
        await vi.waitFor(() => expect(ranCommand(turns.events, 'sleep 15'), describeTarget(target, turns.session)).toBe(true), { timeout: 90_000, interval: 250 });

        const text = 'Reply with only the word: PINEAPPLE';
        const id = turns.session.sendMessage(text);
        expect(turns.session.queued()).toContainEqual({ id, text });
        await untilEnds(turns, 2);

        expect(turns.ends, describeTarget(target, turns.session)).toEqual(['completed', 'completed']);
        const starts = turns.events.filter((e) => e.type === 'turn_start');
        expect(starts).toHaveLength(2);
        expect(starts.at(-1)).toMatchObject({ messageId: id });
        expect(turns.session.getOutput()).toContain('PINEAPPLE');
        expect(turns.session.queued()).toEqual([]);
      } finally {
        runner.stopAll();
        rmSync(dir, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);

    it('raises a permission request a person answers, and the agent acts on the answer', async () => {
      const dir = scratch();
      const { runner, spawn } = harness(target);
      try {
        const turns = await spawn(`${target.runner}-permission`, dir,
          `Use your ${target.shell} tool to run \`touch asked.txt\`. Then reply with one short sentence saying whether it ran.`, 'default');
        await vi.waitFor(() => expect(openRequests(turns.events).length, describeTarget(target, turns.session)).toBeGreaterThan(0), { timeout: 90_000, interval: 250 });

        const [request] = openRequests(turns.events);
        expect(await turns.session.answerPermission(request.id, { decision: 'deny' })).toBe(true);
        await untilEnds(turns, 1);

        expect(turns.ends, describeTarget(target, turns.session)).toEqual([target.afterDeny]);
        expect(turns.events).toContainEqual({ type: 'permission_decided', id: request.id, decision: { decision: 'deny' } });
        expect(existsSync(join(dir, 'asked.txt')), describeTarget(target, turns.session)).toBe(false);
      } finally {
        runner.stopAll();
        rmSync(dir, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);

    it('resumes a finished task from its native session id in a new process', async () => {
      const dir = scratch();
      const { runner, spawn } = harness(target);
      try {
        const first = await spawn(`${target.runner}-resume-1`, dir,
          'Create a file named hello.txt in the current directory containing exactly: hi. Then reply with only the word: done', target.auto);
        await untilEnds(first, 1);
        expect(first.ends, describeTarget(target, first.session)).toEqual(['completed']);
        expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hi');
        const saved = first.session.nativeSessionId();
        expect(saved).toBeTruthy();
        first.session.kill();

        const second = await spawn(`${target.runner}-resume-2`, dir, 'Which file did you create earlier in this session? Answer with its name only, without using any tool.', target.auto, saved!);
        await untilEnds(second, 1);
        expect(second.ends, describeTarget(target, second.session)).toEqual(['completed']);
        expect(second.session.nativeSessionId()).toBe(saved);
        expect(second.session.getOutput()).toContain('hello.txt');
      } finally {
        runner.stopAll();
        rmSync(dir, { recursive: true, force: true });
      }
    }, TIMEOUT_MS);
  });
}
