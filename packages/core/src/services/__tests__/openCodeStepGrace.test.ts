import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunnerSession, StructuredEvent } from '../../interfaces/IRunner';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { OPENCODE_ABORT_GRACE_MS } from '../harness/OpenCodeV2';
import type { AgentProcessDeps } from '../harness/AgentAdapter';
import { patient, removeDir, writeStandIn } from '../../testing';

/*
 * A provider bills a streaming request whether it finishes or not, and
 * OpenCode records an interrupted step as zero, so Ordewell lets a step that
 * is already running end by itself where it can, within a short grace
 * (ADR-0018 L1). Driven against the fake 2.x serve, which streams a step for
 * as long as its cue says and fails it on an interrupt.
 */
const FAKE = resolve(__dirname, '../../../../../bench/pipeline/fake-opencode/fake-opencode-v2.mjs');
const cue = (spec: unknown) => `Do the work. <fake-opencode>${JSON.stringify(spec)}</fake-opencode>`;

interface Serve {
  deps: Pick<AgentProcessDeps, 'spawn' | 'fetch' | 'resolvePath'>;
  /** When each `/interrupt` was posted. */
  interrupts: number[];
  /** When the serve process exited, once it has. */
  exitedAt: () => number | null;
}

let scratch: string;
const children: ChildProcess[] = [];
const cleanups: (() => void)[] = [];

function serve(): Serve {
  scratch = mkdtempSync(join(tmpdir(), 'oc-step-grace-'));
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  // The launch checks that `opencode` resolves; the fake is what actually starts.
  writeStandIn(bin, 'opencode');
  const interrupts: number[] = [];
  let exitedAt: number | null = null;
  return {
    interrupts,
    exitedAt: () => exitedAt,
    deps: {
      resolvePath: async () => bin,
      spawn: (_file, args, options) => {
        const child = nodeSpawn(process.execPath, [FAKE, ...args], options);
        children.push(child);
        if (args.includes('serve')) child.once('exit', () => { exitedAt = Date.now(); });
        return child;
      },
      fetch: (input, init) => {
        const href = input instanceof Request ? input.url : String(input);
        if (init?.method === 'POST' && /\/interrupt(\?|$)/.test(href)) interrupts.push(Date.now());
        return globalThis.fetch(input, init);
      },
    },
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  if (scratch) await removeDir(scratch);
});

describe('a step in flight when a task winds down (ADR-0018 L1)', () => {
  const GRACE = patient(3000);

  async function task(fake: Serve, spec: unknown): Promise<{ session: IRunnerSession; events: StructuredEvent[]; seenAt: number[]; reported: Promise<void> }> {
    const runner = new StructuredRunner({ process: fake.deps, interruptGraceMs: GRACE });
    cleanups.push(() => runner.stopAll());
    const work = join(scratch, 'work');
    mkdirSync(work);
    const session = await runner.spawn({
      taskId: 'step-grace', runner: 'opencode', prompt: cue(spec), modelId: 'fake/fake-model', mode: 'build', cwd: work,
      registry: new RunnerRegistry(), attempt: 1,
    });
    const events: StructuredEvent[] = [];
    const seenAt: number[] = [];
    session.onEvent((e) => { events.push(e); seenAt.push(Date.now()); });
    const reported = new Promise<void>((done) => session.onTaskComplete(() => done()));
    return { session, events, seenAt, reported };
  }

  const stepUsage = (events: StructuredEvent[]) => events.flatMap((e) => (e.type === 'usage' && !e.record.purpose ? [e.record] : []));

  it('lets the step after task_complete end by itself, so its usage is recorded, before anything is interrupted', async () => {
    const fake = serve();
    // The report publishes at the grace while the step after it still streams; it ends a moment later.
    const { session, events, seenAt, reported } = await task(fake, {
      steps: [{ calls: [{ name: 'ordewell_task_complete', args: { status: 'done', summary: 'ok' } }] }],
      delayMs: GRACE + patient(1000),
      usage: { input: 123, output: 45 },
    });
    await reported;
    await session.stop();

    const usage = stepUsage(events);
    expect(usage, JSON.stringify(events)).toHaveLength(2);
    expect(usage.every((r) => r.outputTokens === 45)).toBe(true);
    // Interrupting once the step is over cuts nothing off, and stops the turn from starting another.
    const stepEndedAt = seenAt[events.lastIndexOf(events.filter((e) => e.type === 'usage').at(-1)!)];
    expect(fake.interrupts.every((at) => at >= stepEndedAt)).toBe(true);
    await vi.waitFor(() => expect(fake.exitedAt()).not.toBeNull());
  }, patient(30_000));

  it('kills at once on a second stop while the step is let end', async () => {
    const fake = serve();
    // Neither the step nor an interrupt would end within the grace by themselves.
    const { session, reported } = await task(fake, {
      steps: [{ calls: [{ name: 'ordewell_task_complete', args: { status: 'done', summary: 'ok' } }] }],
      delayMs: patient(20_000),
      interruptDelayMs: patient(20_000),
    });
    await reported;
    const stopping = session.stop();
    const asked = Date.now();
    await session.stop();
    await stopping;

    expect(Date.now() - asked).toBeLessThan(GRACE / 2);
    await vi.waitFor(() => expect(fake.exitedAt()).not.toBeNull());
  }, patient(30_000));
});

describe('an aborted OpenCode 2.x turn with a step in flight', () => {
  async function planner(fake: Serve): Promise<OpenCodeAdapter> {
    const adapter = new OpenCodeAdapter({ ...fake.deps, workspaceEnv: async () => ({}) });
    cleanups.push(() => adapter.dispose());
    await adapter.start({ kind: 'planner', cwd: scratch, systemPrompt: 'plan read-only' });
    return adapter;
  }

  /** Send a turn whose only step streams for a long while, and abort it once the step is under way. */
  async function abortMidStep(adapter: OpenCodeAdapter, interruptDelayMs: number): Promise<{ abortedAt: number; settledAt: number }> {
    const abort = new AbortController();
    const sent = adapter.send(cue({ delayMs: patient(20_000), interruptDelayMs }), () => {}, abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    const abortedAt = Date.now();
    abort.abort();
    await sent;
    return { abortedAt, settledAt: Date.now() };
  }

  it('interrupts the step, and disposes of the serve once OpenCode has acknowledged', async () => {
    const fake = serve();
    const adapter = await planner(fake);
    const { abortedAt } = await abortMidStep(adapter, 300);

    expect(fake.interrupts).toHaveLength(1);
    expect(fake.interrupts[0]).toBeGreaterThanOrEqual(abortedAt);
    await vi.waitFor(() => expect(fake.exitedAt()).not.toBeNull());
    // Not before the step was failed and acknowledged.
    expect(fake.exitedAt()! - abortedAt).toBeGreaterThanOrEqual(250);
  }, patient(30_000));

  it('disposes of the serve when the grace runs out, however long the interrupt takes', async () => {
    const fake = serve();
    const adapter = await planner(fake);
    const { abortedAt, settledAt } = await abortMidStep(adapter, patient(20_000));

    expect(fake.interrupts).toHaveLength(1);
    expect(settledAt - abortedAt).toBeGreaterThanOrEqual(OPENCODE_ABORT_GRACE_MS - 50);
    expect(settledAt - abortedAt).toBeLessThan(OPENCODE_ABORT_GRACE_MS + patient(3000));
    await vi.waitFor(() => expect(fake.exitedAt()).not.toBeNull());
  }, patient(30_000));

  it('cuts the grace short when the serve is disposed meanwhile', async () => {
    const fake = serve();
    const adapter = await planner(fake);
    const abort = new AbortController();
    const sent = adapter.send(cue({ delayMs: patient(20_000), interruptDelayMs: patient(20_000) }), () => {}, abort.signal);
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    await vi.waitFor(() => expect(fake.interrupts).toHaveLength(1));
    const disposedAt = Date.now();
    adapter.dispose();
    await sent;

    expect(Date.now() - disposedAt).toBeLessThan(OPENCODE_ABORT_GRACE_MS / 2);
  }, patient(30_000));
});
