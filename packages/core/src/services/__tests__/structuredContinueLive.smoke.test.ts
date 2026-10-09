import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { SpawnFn } from '../harness/AgentAdapter';
import { StructuredRunner } from '../StructuredRunner';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { IRunnerSession } from '../../interfaces/IRunner';
import { makeSession, taskOf } from './sessionTestKit';

/**
 * Continue, live (ADR-0018, K1): a Session wired the way the hosts wire it,
 * against the installed `claude`. Gated like `structuredRunLive.smoke.test.ts`:
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core structuredContinueLive
 *
 * What it asserts: a finished task's session is found after its working
 * directory is removed and recreated at the same path, as a fresh worktree is,
 * and the continued attempt is verified and summarized on its own; and a
 * session Claude cannot find fails the attempt instead of starting afresh.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'haiku';
const TIMEOUT_MS = 300_000;

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

function liveSession(dir: string) {
  const children: ChildProcess[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = nodeSpawn(command, args, options);
    children.push(child);
    return child;
  };
  const router = new StructuredRunner({ process: { spawn } });
  const requests: RunnerSpawnOptions[] = [];
  const attempts: IRunnerSession[] = [];
  const runner = {
    get activeCount() { return router.activeCount; },
    spawn: async (opts: RunnerSpawnOptions) => { requests.push(opts); const attempt = await router.spawn(opts); attempts.push(attempt); return attempt; },
    stop: vi.fn((id: string) => router.stop(id)),
    stopAll: () => router.stopAll(),
  };
  const session = makeSession({
    runner,
    workspaceRoot: () => dir,
    taskOutput: new BufferedTaskOutputSource(),
  });
  return { session, children, requests, attempts };
}

function planOf(task: Task): LegacyPlanState {
  return { tasks: [task], generatedAt: new Date().toISOString(), status: 'approved', runners: ['claude-code'], lastUpdated: new Date().toISOString() };
}

const assignedModel = { modelId: model, modelLabel: model };

describe.runIf(live)('continue — live', () => {
  it('resumes a finished task\'s session in its recreated directory, and verifies the continued attempt on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-continue-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "continue" }\n');
    const { session, children, requests, attempts } = liveSession(dir);
    try {
      session.loadPlan(planOf(createTask({
        id: 'live-1', order: 1, title: 'Name the word', taskMode: 'acceptEdits', assignedModel,
        prompt: 'Do not read, edit or run anything. Reply with exactly this sentence: The secret word is PELICAN.',
      })), 'Continue', dir);
      await session.executePlan();
      await vi.waitFor(() => expect(taskOf(session, 'live-1')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });
      const saved = taskOf(session, 'live-1')!.runnerSessionId;
      expect(saved).toBeTruthy();
      await vi.waitFor(() => expect(children.every(exited)).toBe(true), { timeout: 10_000 });

      // What a fresh worktree from the integration tip does to the directory.
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);

      await session.continueTask('live-1', 'Do not read, edit or run anything. Which secret word did you name earlier? Answer with: The word was <WORD>.');
      await vi.waitFor(() => expect(taskOf(session, 'live-1')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });

      const continued = taskOf(session, 'live-1')!;
      expect(requests.at(-1)).toMatchObject({ resumeSessionId: saved });
      expect(requests.at(-1)!.prompt).not.toContain('Reply with exactly this sentence');
      expect(continued.verdict?.outcome).toBe('pass');
      // The log tail is the runner's task_complete summary, in its own words;
      // the reply itself is in the continued attempt's output.
      expect(attempts.at(-1)!.getOutput()).toMatch(/The word was PELICAN/i);
      expect(attempts.at(-1)!.getOutput()).not.toContain('The secret word is PELICAN');
      expect(continued.runnerSessionId).toBeTruthy();
      await vi.waitFor(() => expect(children.every(exited)).toBe(true), { timeout: 10_000 });
    } finally {
      session.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS * 2);

  it('fails a continue whose session Claude cannot find, suggesting Retry, and starts nothing fresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-continue-'));
    const { session, children } = liveSession(dir);
    try {
      session.loadPlan(planOf({
        ...createTask({ id: 'live-2', order: 1, title: 'Gone', taskMode: 'acceptEdits', assignedModel, prompt: 'unused', status: 'completed' }),
        runnerSessionId: randomUUID(),
      }), 'Continue', dir);

      await session.continueTask('live-2', 'Reply with only the word: ok');
      await vi.waitFor(() => expect(taskOf(session, 'live-2')?.status).toBe('failed'), { timeout: 60_000, interval: 250 });

      const failed = taskOf(session, 'live-2')!;
      expect(failed.outputSummary?.reviewReason).toMatch(/Could not continue task "Gone": .*saved session\. Retry starts it afresh\./);
      expect(failed.outputSummary?.logTail).toContain('No conversation found');
      expect(failed.runnerSessionId).toBeUndefined();
      expect(children).toHaveLength(1);
      await vi.waitFor(() => expect(exited(children[0])).toBe(true), { timeout: 10_000 });
    } finally {
      session.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
