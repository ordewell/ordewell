import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunnerSession, StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';
import { VerdictEngine } from '../VerdictEngine';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask, type Verdict } from '../../models/Task';

/**
 * The opt-in live check for the OpenCode connector on the structured
 * transport (ADR-0018), gated like `structuredLive.smoke.test.ts` and for the
 * same reasons: real quota, real latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=opencode npx vitest run --root packages/core structuredOpenCodeLive
 *
 * Every task runs in a throwaway directory under `build`, on a cheap model
 * unless ORDEWELL_LIVE_MODEL says otherwise, at its lowest variant. The
 * Ordewell tool cases (ADR-0022) run under `plan`, which is not the
 * `approvals: auto` mode, so a prompt-free call there is the rule at work.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('opencode');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'opencode-go/deepseek-v4.1-flash';
const TIMEOUT_MS = 180_000;

const completionInstruction = 'Then call task_complete with status done and a short summary.';

function turnEnds(session: IRunnerSession) {
  const ends: StructuredTurnEnd[] = [];
  const reports: string[] = [];
  session.onTaskComplete(({ status }) => reports.push(status));
  let waiter: (() => void) | null = null;
  session.onTurnEnd((reason) => { ends.push(reason); waiter?.(); waiter = null; });
  return {
    session,
    ends,
    reports,
    next: () => new Promise<void>((resolve) => { waiter = resolve; }),
  };
}

function harness() {
  let baseUrl: string | null = null;
  const fetchSeen: typeof fetch = (input, init) => {
    baseUrl ??= new URL(input instanceof Request ? input.url : String(input)).origin;
    return globalThis.fetch(input, init);
  };
  const runner = new StructuredRunner({ process: { fetch: fetchSeen } });
  const spawn = async (taskId: string, dir: string, prompt: string, resumeSessionId?: string, mode = 'build') => {
    const session = await runner.spawn({
      taskId,
      runner: 'opencode',
      prompt,
      modelId: model,
      thinkingEffort: 'low',
      mode,
      cwd: dir,
      registry: new RunnerRegistry(),
      attempt: 1,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    const turns = turnEnds(session);
    const events: StructuredEvent[] = [];
    const chunks: string[] = [];
    turns.session.onEvent((e) => events.push(e));
    session.onOutput((text) => chunks.push(text));
    return { session: turns.session, turns, events, chunks };
  };
  return { runner, spawn, baseUrl: () => baseUrl };
}

describe.runIf(live)('structured transport — OpenCode live smoke', () => {
  it('runs a build-mode task turn: writes a file, reports completion through the tool, answers permissions itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events } = await spawn('oc-build', dir,
        `Create a file named hello.txt in the current directory containing exactly: hi. ${completionInstruction}`);
      await turns.next();

      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(existsSync(join(dir, 'hello.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hi');
      expect(turns.reports).toEqual(['done']);
      expect(session.getOutput()).toMatch(/^› \S+/m);

      const asked = events.filter((e) => e.type === 'permission_request');
      const decided = new Set(events.flatMap((e) => (e.type === 'permission_decided' ? [e.id] : [])));
      for (const request of asked) expect(decided.has(request.id)).toBe(true);
      expect(events.filter((e) => e.type === 'permission_withdrawn')).toEqual([]);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('protects the task server with a password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn, baseUrl } = harness();
    try {
      const { turns } = await spawn('oc-auth', dir, 'Reply with only the word: ok');
      const url = baseUrl();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // An API path on both versions: on 2.x a bare `/session` is the web app's page, not the API.
      const response = await globalThis.fetch(`${url}/api/session`);
      expect(response.status).toBe(401);
      await turns.next();
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('hands a message sent during a command to the running turn, which acts on it before the turn ends (ADR-0023)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events } = await spawn('oc-steer', dir,
        'Use the bash tool to run `sleep 20 && echo step1done`. Then use the bash tool to run `echo step2done`. Then reply with one short sentence saying what you ran.');
      await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_call'), JSON.stringify(events)).toBe(true), { timeout: 60_000, interval: 250 });
      await new Promise<void>((resolve) => setTimeout(resolve, 4000));

      const id = session.sendMessage('Before your next command, use the bash tool to run `touch steered.txt`. Then carry on, and include the word PINEAPPLE in your final reply.');
      await turns.next();

      const at = (match: (e: StructuredEvent) => boolean) => events.findIndex(match);
      const handed = at((e) => e.type === 'message_handed_over' && e.messageId === id);
      const delivered = at((e) => e.type === 'message_delivered' && e.messageId === id);
      const touched = events.findIndex((e, i) => i > delivered && e.type === 'tool_call' && JSON.stringify(e.args).includes('steered.txt'));
      console.error(`[live] opencode steer: handed over at ${handed}, delivered at ${delivered}, acted on at ${touched}, turn ended at ${at((e) => e.type === 'turn_end')}`);
      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
      expect(handed).toBeGreaterThan(-1);
      expect(delivered, session.getOutput()).toBeGreaterThan(handed);
      expect(touched, session.getOutput()).toBeGreaterThan(delivered);
      expect(touched).toBeLessThan(at((e) => e.type === 'turn_end'));
      expect(existsSync(join(dir, 'steered.txt'))).toBe(true);
      expect(session.getOutput()).toContain('PINEAPPLE');
      expect(session.queued()).toEqual([]);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the task alive for the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events } = await spawn('oc-interrupt', dir, 'Use the bash tool to run `sleep 60 && echo finished`, then summarize the result.');
      await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_call')).toBe(true), { timeout: 60_000, interval: 250 });

      await session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(session.turnState()).toBe('idle');

      session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('force sends during `sleep 60`: the sleep is cut short, the forced message acted on, no wait for input between (ADR-0023, F1–F3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const { session, turns, events } = await spawn('oc-force', dir, 'Use the bash tool to run `sleep 60 && touch slept.txt`, then summarize the result.');
      const states: string[] = [];
      session.onTurnEnd(() => states.push(session.turnState()));
      await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_call')).toBe(true), { timeout: 60_000, interval: 250 });
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));

      const forcedAt = Date.now();
      const id = session.forceSend('Stop waiting on that command. Use the bash tool to run `touch forced.txt`, then reply with the word PINEAPPLE.');
      while (turns.ends.length < 2) await turns.next();
      const elapsed = Date.now() - forcedAt;
      console.error(`[live] opencode force send: ${elapsed}ms from the force to the end of the turn it opened`);

      expect(turns.ends, session.getOutput()).toEqual(['interrupted', 'completed']);
      expect(states[0]).toBe('working');
      expect(events.filter((e) => e.type === 'turn_start').at(-1)).toMatchObject({ messageId: id, forced: true });
      expect(existsSync(join(dir, 'forced.txt'))).toBe(true);
      expect(existsSync(join(dir, 'slept.txt'))).toBe(false);
      expect(session.getOutput()).toContain('PINEAPPLE');
      expect(elapsed).toBeLessThan(50_000);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('settles a ~20s turn from the idle status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const started = Date.now();
      const { session, turns } = await spawn('oc-long', dir,
        `Use the bash tool to run \`sleep 20\`. ${completionInstruction}`);
      await turns.next();

      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(turns.reports).toEqual(['done']);
      expect(Date.now() - started).toBeLessThan(120_000);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('continues a finished task from its native session id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    try {
      const first = await spawn('oc-continue-1', dir, 'Create a file named hello.txt in the current directory containing exactly: hi. Then reply with only the word: done');
      await first.turns.next();
      const saved = first.session.nativeSessionId();
      expect(saved).toBeTruthy();
      first.session.kill();

      const second = await spawn('oc-continue-2', dir, 'Which file did you write earlier? Answer with its name.', saved!);
      await second.turns.next();
      expect(second.turns.ends, second.session.getOutput()).toEqual(['completed']);
      expect(second.session.getOutput()).toContain('hello.txt');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('completes a task through task_complete without asking anyone, outside the auto mode (ADR-0022)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    const task = createTask({ id: 'oc-tool', title: 'Multiply', prompt: 'Work out 17 * 23 and state the result.', taskMode: 'plan' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    try {
      const { session, turns, events } = await spawn(task.id, dir, composeAugmentedPrompt(task, [task], {  }), undefined, 'plan');
      engine.watch(task, session);

      const decided = await verdict;
      expect(decided.outcome, session.getOutput()).toBe('pass');
      expect(decided.checks[0].name).toBe('task_complete');
      await turns.next();
      const call = events.find((e) => e.type === 'tool_call' && e.name === 'ordewell_task_complete');
      expect(call, session.getOutput()).toBeDefined();
      expect(events.find((e) => e.type === 'tool_result' && call?.type === 'tool_call' && e.id === call.id)).toMatchObject({ success: true });
      expect(events.filter((e) => e.type === 'permission_request' && !e.decided)).toEqual([]);
      console.error(`[live] task_complete verdict for OpenCode session ${session.nativeSessionId()}`);
      session.kill();
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('holds a checkpoint tool call open until it is answered, and returns the answer (ADR-0022, V5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-oc-'));
    const { runner, spawn } = harness();
    const task = createTask({ id: 'oc-checkpoint', title: 'Ask', prompt: 'Your task: call the checkpoint tool with the question "Shall I proceed with the migration?", then state exactly what the result was. Whatever it is, do not call the checkpoint tool a second time.', taskMode: 'plan', autonomy: 'HITL' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    const asked: string[] = [];
    engine.onCheckpoint((taskId, question) => {
      asked.push(question);
      // Past the 5s OpenCode gives a remote server by default, and past the MCP SDK's 60s request timeout: the heartbeat is what keeps the call alive.
      setTimeout(() => (asked.length === 1 ? engine.rejectCheckpoint(taskId, 'not today') : engine.approveCheckpoint(taskId)), 70_000);
    });
    try {
      const { session, events } = await spawn(task.id, dir, composeAugmentedPrompt(task, [task], {  }), undefined, 'plan');
      engine.watch(task, session);

      await verdict;
      const call = events.find((e) => e.type === 'tool_call' && e.name === 'ordewell_checkpoint');
      expect(call, session.getOutput()).toBeDefined();
      expect(asked).toHaveLength(1);
      expect(events.find((e) => e.type === 'tool_result' && call?.type === 'tool_call' && e.id === call.id)).toMatchObject({ success: true, output: 'rejected: not today' });
      expect(events.filter((e) => e.type === 'permission_request' && !e.decided)).toEqual([]);
      session.kill();
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
