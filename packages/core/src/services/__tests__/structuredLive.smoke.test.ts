import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
 * The opt-in live check for the structured transport (ADR-0018), gated like
 * `harnessLive.smoke.test.ts` and for the same reasons: real quota, real
 * latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core structuredLive
 *
 * It runs in a throwaway directory under `acceptEdits`, on the cheapest model
 * unless ORDEWELL_LIVE_MODEL says otherwise. What it asserts is the transport:
 * completion is reported through a tool, tool output becomes one line, a soft
 * interrupt ends the turn without ending the task, a turn is not closed
 * while background work is still running, and a task completes through the
 * `task_complete` tool without an approval, and a `checkpoint` call stays
 * open until the checkpoint is answered (ADR-0022), and a message sent during
 * a command reaches the model inside the same turn, and a forced message cuts
 * that command short (ADR-0023).
 *
 * The `auto` case needs a model and an account the CLI offers auto mode on. If
 * it refuses, the case is skipped with the CLI's own words — the mode is never
 * swapped for another one (ADR-0001).
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'haiku';
// Haiku does not offer auto mode: the CLI starts in `default` and says nothing.
const autoModel = process.env.ORDEWELL_LIVE_AUTO_MODEL ?? model;
const TIMEOUT_MS = 180_000;

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

describe.runIf(live)('structured transport — live smoke', () => {
  it('runs a Claude Code task turn and reports completion through the tool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    const runner = new StructuredRunner();
    try {
      const session = await runner.spawn({
        taskId: 'live-smoke',
        runner: 'claude-code',
        prompt: 'Run `cat README.md` with the Bash tool. Then call task_complete with status done and a short summary.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const chunks: string[] = [];
      const exits: number[] = [];
      session.onOutput((text) => chunks.push(text));
      session.onExit((code) => exits.push(code));

      await turns.next();
      expect(turns.ends).toEqual(['completed']);
      expect(turns.reports).toEqual(['done']);
      expect(session.getOutput()).toMatch(/› Bash\(cat README\.md\)/);
      expect(turns.session.nativeSessionId()).toBeTruthy();

      session.kill();
      session.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(exits).toHaveLength(1);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('keeps the turn open while background work runs, and reports completion after it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      const startedAt = Date.now();
      const session = await runner.spawn({
        taskId: 'live-background',
        runner: 'claude-code',
        prompt: 'Start `sleep 20 && echo BG-DONE` as a background shell with the Bash tool (run_in_background). Wait for it to finish and read its output. Only then call task_complete with status done and a short summary.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const chunks: string[] = [];
      session.onOutput((text) => chunks.push(text));

      await turns.next();
      // Long enough that the 20s sleep, not a quick reply, is what held it.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15_000);
      expect(turns.reports).toEqual(['done']);
      // Nothing straggles in after the turn, and no second turn ends.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(turns.ends).toEqual(['completed']);
      expect(turns.reports).toEqual(['done']);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('runs a task under auto mode, or skips with the reason the run gave', async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      const session = await runner.spawn({
        taskId: 'live-auto',
        runner: 'claude-code',
        prompt: 'Write a file named hello.txt containing the single word hello. Then call task_complete with status done and a short summary.',
        modelId: autoModel,
        mode: 'auto',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const exited = new Promise<number>((resolve) => session.onExit(resolve));
      const outcome = await Promise.race([turns.next().then(() => 'turn' as const), exited.then(() => 'exit' as const)]);

      if (outcome === 'exit' || turns.ends[0] === 'failed') {
        console.warn(`[live] auto mode on ${autoModel} skipped: ${session.getOutput().trim()}`);
        ctx.skip();
        return;
      }
      expect(turns.ends).toEqual(['completed']);
      expect(turns.reports).toEqual(['done']);
      expect(existsSync(join(dir, 'hello.txt'))).toBe(true);
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hello');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the task alive for the next message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      const session = await runner.spawn({
        taskId: 'live-interrupt',
        runner: 'claude-code',
        prompt: 'Use the Bash tool to run `sleep 60 && echo finished`, then summarize the result.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const started = new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));
      await started;

      await turns.session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(turns.session.turnState()).toBe('idle');

      turns.session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('hands a message sent during a command to the running turn, which acts on it before the turn ends (ADR-0023)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      // Bypass, in a throwaway directory: a command waiting on an approval would hold the turn, not the steer.
      const session = await runner.spawn({
        taskId: 'live-steer',
        runner: 'claude-code',
        prompt: 'Use the Bash tool to run `sleep 20 && echo step1done`. Then use the Bash tool to run `echo step2done`. Then reply with one short sentence saying what you ran.',
        modelId: model,
        mode: 'bypassPermissions',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const events: StructuredEvent[] = [];
      turns.session.onEvent((e) => events.push(e));
      await vi.waitFor(() => expect(events.some((e) => e.type === 'tool_call')).toBe(true), { timeout: 60_000, interval: 250 });
      await new Promise<void>((resolve) => setTimeout(resolve, 4000));

      const id = turns.session.sendMessage('Before your next command, use the Bash tool to run `touch steered.txt`. Then carry on, and include the word PINEAPPLE in your final reply.');
      await turns.next();

      const at = (match: (e: StructuredEvent) => boolean) => events.findIndex(match);
      const handed = at((e) => e.type === 'message_handed_over' && e.messageId === id);
      const delivered = at((e) => e.type === 'message_delivered' && e.messageId === id);
      const touched = events.findIndex((e, i) => i > delivered && e.type === 'tool_call' && JSON.stringify(e.args).includes('steered.txt'));
      const ended = at((e) => e.type === 'turn_end');
      console.error(`[live] claude steer: handed over at ${handed}, delivered at ${delivered}, acted on at ${touched}, turn ended at ${ended}`);
      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
      expect(handed).toBeGreaterThan(-1);
      expect(delivered, session.getOutput()).toBeGreaterThan(handed);
      // Read after the sleep's result, inside the same turn.
      expect(delivered).toBeGreaterThan(at((e) => e.type === 'tool_result'));
      expect(touched, session.getOutput()).toBeGreaterThan(delivered);
      expect(touched).toBeLessThan(ended);
      expect(existsSync(join(dir, 'steered.txt'))).toBe(true);
      expect(session.getOutput()).toContain('PINEAPPLE');
      expect(turns.session.queued()).toEqual([]);
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('force sends during a 60s sleep: the sleep is cut short, the forced message acted on, no wait for input between (ADR-0023, F1–F3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    try {
      const session = await runner.spawn({
        taskId: 'live-force',
        runner: 'claude-code',
        // Claude Code refuses a foreground `sleep N && …` and steers the model
        // to run it in the background, where there is no tool call to cut short.
        prompt: 'Use the Bash tool, in the foreground, to run `python3 -c "import time; time.sleep(60)" && touch slept.txt`, then summarize the result.',
        modelId: model,
        mode: 'acceptEdits',
        cwd: dir,
        registry: new RunnerRegistry(),
      });
      const turns = turnEnds(session);
      const events: StructuredEvent[] = [];
      const states: string[] = [];
      turns.session.onEvent((e) => events.push(e));
      turns.session.onTurnEnd(() => states.push(turns.session.turnState()));
      await new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));

      const forcedAt = Date.now();
      const id = turns.session.forceSend('Stop waiting on that command. Use the Bash tool to run `touch forced.txt`, then reply with the word PINEAPPLE.');
      while (turns.ends.length < 2) await turns.next();
      const elapsed = Date.now() - forcedAt;
      console.error(`[live] claude force send: ${elapsed}ms from the force to the end of the turn it opened`);

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

  it('completes a task through task_complete in default mode, with nothing asked of a person (ADR-0022)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    const task = createTask({ id: 'live-tool', title: 'Multiply', prompt: 'Work out 17 * 23 and state the result.', taskMode: 'default' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    try {
      const session = await runner.spawn({
        taskId: task.id,
        runner: 'claude-code',
        prompt: composeAugmentedPrompt(task, [task], {  }),
        modelId: model,
        mode: 'default',
        cwd: dir,
        registry: new RunnerRegistry(),
        attempt: 1,
      });
      const turns = turnEnds(session);
      const events: StructuredEvent[] = [];
      turns.session.onEvent((event) => events.push(event));
      engine.watch(task, session);

      const decided = await verdict;
      expect(decided.outcome).toBe('pass');
      expect(decided.checks[0].name, session.getOutput()).toBe('task_complete');
      await turns.next();
      const call = events.find((e) => e.type === 'tool_call' && e.name === 'mcp__ordewell__task_complete');
      expect(call).toBeDefined();
      expect(events.find((e) => e.type === 'tool_result' && call?.type === 'tool_call' && e.id === call.id)).toMatchObject({ success: true });
      expect(events.filter((e) => e.type === 'permission_request' && !e.decided)).toEqual([]);
      console.error(`[live] task_complete verdict for Claude Code session ${turns.session.nativeSessionId()}`);
      session.kill();
    } finally {
      runner.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('holds a checkpoint tool call open until it is answered, and returns the answer (ADR-0022, V5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-'));
    const runner = new StructuredRunner();
    const task = createTask({ id: 'live-checkpoint', title: 'Ask', prompt: 'Your task: call the checkpoint tool with the question "Shall I proceed with the migration?", then state exactly what the result was. Whatever it is, do not call the checkpoint tool a second time.', taskMode: 'default', autonomy: 'HITL' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    const asked: string[] = [];
    engine.onCheckpoint((taskId, question) => {
      asked.push(question);
      // A model told "rejected" may ask again; only the first ask is refused.
      setTimeout(() => (asked.length === 1 ? engine.rejectCheckpoint(taskId, 'not today') : engine.approveCheckpoint(taskId)), 3000);
    });
    try {
      const session = await runner.spawn({
        taskId: task.id,
        runner: 'claude-code',
        prompt: composeAugmentedPrompt(task, [task], {  }),
        modelId: model,
        mode: 'default',
        cwd: dir,
        registry: new RunnerRegistry(),
        attempt: 1,
      });
      const events: StructuredEvent[] = [];

      session.onEvent((event) => events.push(event));
      engine.watch(task, session);

      await verdict;
      const call = events.find((e) => e.type === 'tool_call' && e.name === 'mcp__ordewell__checkpoint');
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
