import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { SpawnFn } from '../harness/AgentAdapter';
import { StructuredRunner } from '../StructuredRunner';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { SessionMessage } from '../SessionMessage';
import { makeSession, taskOf } from './sessionTestKit';

/**
 * A whole structured run, live (ADR-0018): a Session wired the way the hosts
 * wire it, and two Claude Code tasks where the
 * second depends on the first. Gated like `structuredLive.smoke.test.ts`:
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code npx vitest run --root packages/core structuredRunLive
 *
 * What it asserts is the run: task 1 passes on its marker, its process ends
 * with its verdict, and task 2's prompt carries task 1's summary.
 */

const live = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).includes('claude-code');
const model = process.env.ORDEWELL_LIVE_MODEL ?? 'haiku';
const TIMEOUT_MS = 300_000;

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe.runIf(live)('structured run — live', () => {
  it('runs two dependent Claude Code tasks on the structured transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-run-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "structured-run" }\n');
    const children: ChildProcess[] = [];
    const spawn: SpawnFn = (command, args, options) => {
      const child = nodeSpawn(command, args, options);
      children.push(child);
      return child;
    };
    const router = new StructuredRunner({ process: { spawn } });
    const prompts = new Map<string, string>();
    const runner = {
      get activeCount() { return router.activeCount; },
      spawn: (opts: RunnerSpawnOptions) => { prompts.set(opts.taskId, opts.prompt); return router.spawn(opts); },
      stop: vi.fn((id: string) => router.stop(id)),
      stopAll: () => router.stopAll(),
    };
    const session = makeSession({
      runner,
      workspaceRoot: () => dir,
      taskOutput: new BufferedTaskOutputSource(),
    });
    const assignedModel = { modelId: model, modelLabel: model };
    const plan: LegacyPlanState = {
      tasks: [
        createTask({
          id: 'live-1', order: 1, title: 'Name the word', taskMode: 'acceptEdits', assignedModel,
          prompt: 'Do not use any tools. Reply with exactly this sentence: The secret word is PELICAN.',
        }),
        createTask({
          id: 'live-2', order: 2, title: 'Repeat the word', taskMode: 'acceptEdits', assignedModel, dependencies: ['live-1'],
          prompt: 'Do not use any tools. Say which secret word the earlier task named.',
        }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };

    try {
      session.loadPlan(plan, 'Structured run', dir);
      await session.executePlan();

      await vi.waitFor(() => expect(taskOf(session, 'live-1')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });
      const first = taskOf(session, 'live-1')!;
      expect(first.verdict?.outcome).toBe('pass');
      expect(first.verdict?.checks.find((c) => c.name === 'completion_marker')?.passed).toBe(true);
      expect(first.transport).toMatchObject({ kind: 'structured', nativeSessionId: expect.any(String) });
      // The summary is whatever the runner's task_complete call reported
      // (ADR-0022), worded by the model, so the run is checked by carrying it.
      const summary = first.outputSummary?.logTail?.trim().split('\n')[0] ?? '';
      expect(summary.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(exited(children[0])).toBe(true), { timeout: 10_000 });

      await vi.waitFor(() => expect(taskOf(session, 'live-2')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });
      expect(prompts.get('live-2')).toContain(summary);
      await vi.waitFor(() => expect(children.every(exited)).toBe(true), { timeout: 10_000 });
    } finally {
      session.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS * 2);

  // Mode `default` is "Ask before edits": the write is a request Claude asks
  // over the control channel, and the task waits on it for as long as it takes.
  it('parks an Ask before edits task on its write until the request is answered (A1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-approval-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "structured-approval" }\n');
    const router = new StructuredRunner();
    const sent: SessionMessage[] = [];
    const session = makeSession({
      runner: router,
      workspaceRoot: () => dir,
      broadcast: (m) => sent.push(m),
      taskOutput: new BufferedTaskOutputSource(),
    });
    const plan: LegacyPlanState = {
      tasks: [createTask({
        id: 'live-approval', order: 1, title: 'Write a note', taskMode: 'default', assignedModel: { modelId: model, modelLabel: model },
        prompt: 'Use the Write tool to create notes.txt containing exactly the word hello. Do nothing else.',
      })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
    const logged = () => sent.flatMap((m) => (m.type === 'task_log' ? m.events : []));

    try {
      session.loadPlan(plan, 'Structured approval', dir);
      await session.executePlan();

      await vi.waitFor(() => expect(session.outstandingApprovals()).toHaveLength(1), { timeout: TIMEOUT_MS, interval: 250 });
      const [pending] = session.outstandingApprovals();
      expect(pending.request).toMatchObject({ kind: 'runner_tool', taskId: 'live-approval', scope: 'Write', allowForTask: true });
      expect(taskOf(session, 'live-approval')?.status).toBe('in_progress');
      const status = sent.filter((m): m is Extract<SessionMessage, { type: 'status_update' }> => m.type === 'status_update').at(-1);
      expect(status?.tasks.find((t) => t.id === 'live-approval')?.awaitingApproval).toBe(1);
      expect(sent.some((m) => m.type === 'approval_request')).toBe(false);
      expect(existsSync(join(dir, 'notes.txt'))).toBe(false);

      expect(session.resolveApproval(pending.id, { decision: 'allow' })).toBe(true);
      await vi.waitFor(() => expect(taskOf(session, 'live-approval')?.status).toBe('completed'), { timeout: TIMEOUT_MS, interval: 500 });
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8').trim()).toBe('hello');
      expect(logged()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'approval_requested', approvalId: pending.id, tool: 'Write', allowForTask: true }),
        { type: 'approval_decided', approvalId: pending.id, decision: 'allow' },
      ]));
    } finally {
      session.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS * 2);

  it('hands a denial\'s note to the agent, and denies what is left when the task is cancelled (A1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-structured-deny-'));
    writeFileSync(join(dir, 'package.json'), '{ "name": "structured-deny" }\n');
    const router = new StructuredRunner();
    const sent: SessionMessage[] = [];
    const session = makeSession({
      runner: router,
      workspaceRoot: () => dir,
      broadcast: (m) => sent.push(m),
      taskOutput: new BufferedTaskOutputSource(),
    });
    const plan: LegacyPlanState = {
      tasks: [createTask({
        id: 'live-deny', order: 1, title: 'Write a note', taskMode: 'default', assignedModel: { modelId: model, modelLabel: model },
        prompt: 'Use the Write tool to create a.txt containing a. If that is denied, follow the reason you are given.',
      })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
    const logged = () => sent.flatMap((m) => (m.type === 'task_log' ? m.events : []));
    const writes = () => logged().flatMap((e) => (e.type === 'approval_requested' ? [e] : []));

    try {
      session.loadPlan(plan, 'Structured deny', dir);
      await session.executePlan();

      await vi.waitFor(() => expect(session.outstandingApprovals()).toHaveLength(1), { timeout: TIMEOUT_MS, interval: 250 });
      session.resolveApproval(session.outstandingApprovals()[0].id, { decision: 'deny', note: 'Not a.txt — write it to notes/b.txt instead.' });
      await vi.waitFor(() => expect(logged()).toContainEqual(expect.objectContaining({ type: 'tool_result', success: false, output: 'Not a.txt — write it to notes/b.txt instead.' })), { timeout: TIMEOUT_MS, interval: 250 });

      await vi.waitFor(() => expect(writes()).toHaveLength(2), { timeout: TIMEOUT_MS, interval: 250 });
      expect(writes()[1].args).toContain('notes/b.txt');
      await session.cancelTask('live-deny');
      expect(session.outstandingApprovals()).toEqual([]);
      await vi.waitFor(() => expect(logged()).toContainEqual({ type: 'approval_decided', approvalId: writes()[1].approvalId, decision: 'deny' }), { timeout: 10_000 });
      expect(existsSync(join(dir, 'a.txt'))).toBe(false);
      expect(existsSync(join(dir, 'notes', 'b.txt'))).toBe(false);
    } finally {
      session.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS * 2);
});

