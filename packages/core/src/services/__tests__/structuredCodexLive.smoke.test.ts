import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { isStructuredSession, type ITerminalSession, type StructuredEvent, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';
import { VerdictEngine } from '../VerdictEngine';
import { composeAugmentedPrompt } from '../promptAugment';
import { createTask, type Verdict } from '../../models/Task';

/**
 * The opt-in live check for the Codex task connector on the structured
 * transport (ADR-0018, #54), gated like `structuredLive.smoke.test.ts` and for
 * the same reasons: real quota, real latency, no credentials in CI.
 *
 *   ORDEWELL_LIVE_AGENTS=codex npx vitest run --root packages/core structuredCodexLive
 *
 * `task_complete` and `checkpoint` go through the Ordewell MCP server Codex is
 * given for the thread (ADR-0022).
 *
 * Every case runs in a throwaway directory with dummy work. A Codex sandbox
 * that cannot start here fails the write cases with the connector's own
 * message in the assertion, never a pass.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('codex');
// gpt-5.4-mini is not in this account's catalog; luna is the cheapest listed.
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'gpt-5.6-luna';
const TIMEOUT_MS = 180_000;
const COMPLETION_PROMPT = 'Then call task_complete with status done and a short summary.';

function turnEnds(session: ITerminalSession) {
  if (!isStructuredSession(session)) throw new Error('not a structured session');
  const ends: StructuredTurnEnd[] = [];
  const reports: string[] = [];
  session.onTaskComplete(({ status }) => reports.push(status));
  const events: StructuredEvent[] = [];
  let waiter: (() => void) | null = null;
  session.onTurnEnd((reason) => { ends.push(reason); waiter?.(); waiter = null; });
  session.onEvent((e) => events.push(e));
  return {
    session,
    ends,
    reports,
    events,
    next: () => new Promise<void>((resolve) => { waiter = resolve; }),
  };
}

function spawnTask(runner: StructuredRunner, dir: string, taskId: string, prompt: string, mode: string, resumeSessionId?: string) {
  return runner.spawn({
    taskId,
    runner: 'codex',
    prompt,
    modelId: model,
    thinkingEffort: 'low',
    mode,
    cwd: dir,
    registry: new RunnerRegistry(),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  });
}

describe.runIf(live)('structured transport, Codex — live smoke', () => {
  const dirs: string[] = [];
  const dirFor = () => { const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-codex-')); dirs.push(dir); return dir; };
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it('full auto: writes a file, reports completion through the tool, one shell line, one completed turn', async () => {
    const dir = dirFor();
    const runner = new StructuredRunner();
    try {
      const session = await spawnTask(runner, dir, 'live-codex-full', `Run a shell command that writes the text hi into hello.txt. ${COMPLETION_PROMPT}`, 'fullAccess');
      const turns = turnEnds(session);
      const chunks: string[] = [];
      session.onOutput((text) => chunks.push(text));

      await turns.next();
      expect(turns.ends).toEqual(['completed']);
      expect(existsSync(join(dir, 'hello.txt')), session.getOutput()).toBe(true);
      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toContain('hi');
      expect(turns.reports).toEqual(['done']);
      expect(session.getOutput().match(/^› shell\(/gm) ?? []).toHaveLength(1);
    } finally { runner.stopAll(); }
  }, TIMEOUT_MS);

  it('Auto: a write inside the workspace needs no permission request', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-auto', `Run a shell command that writes the text hi into hello.txt. ${COMPLETION_PROMPT}`, 'agent');
      const turns = turnEnds(session);
      await turns.next();
      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(turns.events.filter((e) => e.type === 'permission_request')).toEqual([]);
      expect(existsSync(join(dir, 'hello.txt')), session.getOutput()).toBe(true);
      expect(turns.reports).toEqual(['done']);
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  it('hands a message sent during a command to the running turn, which acts on it before the turn ends (ADR-0023)', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-steer', 'Run the shell command `sleep 20 && echo step1done`. Then run the shell command `echo step2done`. Then reply with one short sentence saying what you ran.', 'fullAccess');
      const turns = turnEnds(session);
      await new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));
      await new Promise<void>((resolve) => setTimeout(resolve, 4000));

      const id = turns.session.sendMessage('Before your next command, run the shell command `touch steered.txt`. Then carry on, and include the word PINEAPPLE in your final reply.');
      await turns.next();

      const at = (match: (e: StructuredEvent) => boolean) => turns.events.findIndex(match);
      const delivered = at((e) => e.type === 'message_delivered' && e.messageId === id);
      const touched = turns.events.findIndex((e, i) => i > delivered && e.type === 'tool_call' && JSON.stringify(e.args).includes('steered.txt'));
      console.error(`[live] steer: handed over at ${at((e) => e.type === 'message_handed_over')}, delivered at ${delivered}, acted on at ${touched}, turn ended at ${at((e) => e.type === 'turn_end')}`);
      expect(turns.ends, session.getOutput()).toEqual(['completed']);
      expect(turns.events.filter((e) => e.type === 'turn_start')).toHaveLength(1);
      expect(at((e) => e.type === 'message_handed_over' && e.messageId === id)).toBeGreaterThan(-1);
      expect(delivered, session.getOutput()).toBeGreaterThan(at((e) => e.type === 'message_handed_over'));
      expect(touched, session.getOutput()).toBeGreaterThan(delivered);
      expect(touched).toBeLessThan(at((e) => e.type === 'turn_end'));
      expect(existsSync(join(dir, 'steered.txt'))).toBe(true);
      expect(session.getOutput()).toContain('PINEAPPLE');
      expect(turns.session.queued()).toEqual([]);
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  it('interrupts a turn and keeps the session alive for the next message', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-interrupt', 'Run the shell command `sleep 60`, then summarize the result.', 'fullAccess');
      const turns = turnEnds(session);
      await new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));

      await turns.session.interrupt();
      expect(turns.ends).toEqual(['interrupted']);
      expect(turns.session.turnState()).toBe('idle');

      turns.session.sendMessage('Reply with only the word: ok');
      await turns.next();
      expect(turns.ends).toEqual(['interrupted', 'completed']);
      expect(session.getOutput().toLowerCase()).toContain('ok');
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  // Codex aborts the turn but lets the command run on (F4), so only the
  // forced turn's timing shows the wait was cut short — not a missing file.
  it('force sends during `sleep 60`: the wait is cut short, the forced message acted on, no wait for input between (ADR-0023, F1–F4)', async () => {
    const dir = dirFor();
    const own = new StructuredRunner();
    try {
      const session = await spawnTask(own, dir, 'live-codex-force', 'Run the shell command `sleep 60 && echo slept`, then summarize the result.', 'fullAccess');
      const turns = turnEnds(session);
      const states: string[] = [];
      turns.session.onTurnEnd(() => states.push(turns.session.turnState()));
      await new Promise<void>((resolve) => turns.session.onEvent((e) => { if (e.type === 'tool_call') resolve(); }));
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));

      const forcedAt = Date.now();
      const id = turns.session.forceSend('Stop waiting on that command. Run the shell command `touch forced.txt`, then reply with the word PINEAPPLE.');
      while (turns.ends.length < 2) await turns.next();
      const elapsed = Date.now() - forcedAt;
      console.error(`[live] codex force send: ${elapsed}ms from the force to the end of the turn it opened`);

      expect(turns.ends, session.getOutput()).toEqual(['interrupted', 'completed']);
      expect(states[0]).toBe('working');
      expect(turns.events.filter((e) => e.type === 'turn_start').at(-1)).toMatchObject({ messageId: id, forced: true });
      expect(existsSync(join(dir, 'forced.txt'))).toBe(true);
      expect(session.getOutput()).toContain('PINEAPPLE');
      expect(elapsed).toBeLessThan(50_000);
    } finally { own.stopAll(); }
  }, TIMEOUT_MS);

  it('continues a finished session by its native id', async () => {
    const dir = dirFor();
    const first = new StructuredRunner();
    const second = new StructuredRunner();
    try {
      const session = await spawnTask(first, dir, 'live-codex-continue-1', 'Run a shell command that writes the text hi into hello.txt, then reply with only the word done.', 'fullAccess');
      const turns = turnEnds(session);
      await turns.next();
      const nativeId = turns.session.nativeSessionId();
      expect(nativeId).toBeTruthy();
      session.kill();

      const resumed = await spawnTask(second, dir, 'live-codex-continue-2', 'Which file did you write earlier? Answer with its name.', 'fullAccess', nativeId!);
      const again = turnEnds(resumed);
      await again.next();
      expect(again.ends, resumed.getOutput()).toEqual(['completed']);
      expect(resumed.getOutput()).toContain('hello.txt');
    } finally { first.stopAll(); second.stopAll(); }
  }, TIMEOUT_MS * 2);

  it('completes a task through task_complete, with nothing asked of a person (ADR-0022)', async () => {
    const dir = dirFor();
    const runner = new StructuredRunner();
    const task = createTask({ id: 'live-codex-tool', title: 'Multiply', prompt: 'Work out 17 * 23 and state the result.', taskMode: 'fullAccess' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    try {
      const session = await runner.spawn({
        taskId: task.id,
        runner: 'codex',
        prompt: composeAugmentedPrompt(task, [task], {  }),
        modelId: model,
        thinkingEffort: 'low',
        mode: 'fullAccess',
        cwd: dir,
        registry: new RunnerRegistry(),
        attempt: 1,
      });
      const turns = turnEnds(session);
      engine.watch(task, session);

      const decided = await verdict;
      expect(decided.outcome).toBe('pass');
      expect(decided.checks[0].name, session.getOutput()).toBe('task_complete');
      await turns.next();
      const call = turns.events.find((e) => e.type === 'tool_call' && e.name === 'mcp__ordewell__task_complete');
      expect(call).toBeDefined();
      expect(turns.events.find((e) => e.type === 'tool_result' && call?.type === 'tool_call' && e.id === call.id)).toMatchObject({ success: true });
      expect(turns.events.filter((e) => e.type === 'permission_request')).toEqual([]);
      console.error(`[live] task_complete verdict for Codex thread ${turns.session.nativeSessionId()}`);
      session.kill();
    } finally { runner.stopAll(); }
  }, TIMEOUT_MS);

  it('holds a checkpoint tool call open past Codex\'s default tool timeout, and returns the answer (ADR-0022, V5)', async () => {
    const dir = dirFor();
    const runner = new StructuredRunner();
    const task = createTask({ id: 'live-codex-checkpoint', title: 'Ask', prompt: 'Your task: call the checkpoint tool with the question "Shall I proceed with the migration?", then state exactly what the result was. Do not call the checkpoint tool a second time.', taskMode: 'fullAccess', autonomy: 'HITL' });
    const engine = new VerdictEngine();
    const verdict = new Promise<Verdict>((resolve) => engine.onVerdict((_taskId, v) => resolve(v)));
    const asked: string[] = [];
    engine.onCheckpoint((taskId, question) => {
      asked.push(question);
      // Longer than the 60s Codex gives a tool call that reports no result.
      setTimeout(() => engine.rejectCheckpoint(taskId, 'not today'), 75_000);
    });
    try {
      const session = await runner.spawn({
        taskId: task.id,
        runner: 'codex',
        prompt: composeAugmentedPrompt(task, [task], {  }),
        modelId: model,
        thinkingEffort: 'low',
        mode: 'fullAccess',
        cwd: dir,
        registry: new RunnerRegistry(),
        attempt: 1,
      });
      const turns = turnEnds(session);
      engine.watch(task, session);

      await verdict;
      const call = turns.events.find((e) => e.type === 'tool_call' && e.name === 'mcp__ordewell__checkpoint');
      expect(call, session.getOutput()).toBeDefined();
      expect(asked).toHaveLength(1);
      expect(turns.events.find((e) => e.type === 'tool_result' && call?.type === 'tool_call' && e.id === call.id)).toMatchObject({ success: true, output: 'rejected: not today' });
      session.kill();
    } finally { runner.stopAll(); }
  }, TIMEOUT_MS * 2);
});
