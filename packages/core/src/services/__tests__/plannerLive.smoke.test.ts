import { execFileSync, spawn } from 'child_process';
import { describe, it, expect } from 'vitest';
import { OpenAiService } from '../OpenAiService';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { DEFAULT_PLANNER_MODES } from '../plannerModes';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { AiProvider } from '../../interfaces/IConfig';
import type { RunnerId } from '../../models/Task';

/**
 * The opt-in live check for the planner-facing mode set — the part of the mode
 * work that only a real model can settle.
 *
 *   ORDEWELL_LIVE_PLANNER=1 OPENROUTER_API_KEY=… \
 *     npx vitest run --root packages/core plannerLive
 *
 * Like `harnessLive.smoke.test.ts` it is not part of the suite: it costs real
 * tokens and tens of seconds per case. It asserts the *shape* the mode set is
 * supposed to produce (a final review task, and no review task without the
 * toggle) rather than the quality of the plan, which would be a test of the
 * model.
 */

const liveEnabled = process.env.ORDEWELL_LIVE_PLANNER === '1' && !!process.env.OPENROUTER_API_KEY;
const agents = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Generous because the bound is the provider's queue, not the work: the same
 * deepseek-v4-flash plan has come back in 30s and in 264s within an hour. A
 * tighter limit reports OpenRouter's load as a Ordewell failure.
 */
const TIMEOUT_MS = 600_000;

/** Cheap, fast, and both are strong enough to follow a structured plan schema. */
const MODELS = ['deepseek/deepseek-v4-flash', 'openai/gpt-5.6-luna'];

const GOAL = 'Add a --dry-run flag to the CLI that prints what would happen without writing anything.';

function openrouter(model: string) {
  const key = process.env.OPENROUTER_API_KEY!;
  return new OpenAiService(fakeConfig({
    aiProvider: 'openrouter',
    planningModel: model,
    // The one-shot path streams plan text through the orchestrator model.
    orchestratorModel: model,
    apiKey: key,
    openrouterKey: key,
    getProviderApiKey: () => key,
    getProviderBaseUrl: () => 'https://openrouter.ai/api/v1',
  }));
}

/**
 * The two axis headings appear nowhere but the review block, which makes them a
 * sharp negative signal: a plan that never saw the block cannot mention them.
 * They are a poor *positive* one, because a cheap model paraphrases prose it has
 * understood — deepseek-v4-flash emitted a task titled "Final review of the
 * --dry-run implementation" with the axes reworded, which is the block working.
 */
const mentionsReviewAxes = (prompt: string): boolean =>
  /spec axis/i.test(prompt) && /standards axis/i.test(prompt);

describe.runIf(liveEnabled)('planner mode set — live', () => {
  for (const model of MODELS) {
    it(`${model} emits a final review task when review mode is on`, async () => {
      const tasks = await openrouter(model).generatePlanDirect(
        GOAL, ['claude-code'], { 'claude-code': [] }, undefined, undefined, undefined, undefined,
        { ...DEFAULT_PLANNER_MODES, review: true },
      );

      expect(tasks.length).toBeGreaterThan(1);
      const ordered = [...tasks].sort((a, b) => a.order - b.order);
      const last = ordered.at(-1)!;
      // Three signals the block demands and a plain plan does not produce
      // together: the last task reviews, needs a human, and gates on everything
      // before it. Without the toggle the same goal ends in an AFK
      // implementation or manual-check task with none of the three.
      expect(
        /review/i.test(`${last.title} ${last.prompt ?? ''}`),
        `last task "${last.title}" does not review — review mode did not reach the model`,
      ).toBe(true);
      expect(last.autonomy).toBe('HITL');
      expect(last.dependencies.length).toBe(ordered.length - 1);
    }, TIMEOUT_MS);

    it(`${model} emits no review task when review mode is off`, async () => {
      const tasks = await openrouter(model).generatePlanDirect(
        GOAL, ['claude-code'], { 'claude-code': [] }, undefined, undefined, undefined, undefined,
        DEFAULT_PLANNER_MODES,
      );

      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.some((t) => mentionsReviewAxes(t.prompt ?? ''))).toBe(false);
    }, TIMEOUT_MS);
  }
});

function liveService(agent: AiProvider) {
  return new CliAgentAiService(
    fakeConfig({ aiProvider: agent, enabledRunners: [agent as RunnerId] }),
    { spawn, workspaceRoot: () => process.cwd() },
  );
}

/**
 * Descendants of this test process only. Matching agent binaries by name would
 * count the developer's own editor session, which is both wrong and the sort of
 * thing that tempts a test into killing it.
 */
function descendants(root = process.pid): number[] {
  const out = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of out.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) { found.push(child); walk(child); }
  };
  walk(root);
  return found;
}

describe.runIf(agents.length > 0)('harness planner process lifecycle — live', () => {
  for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
    it.runIf(agents.includes(agent))(`${agent} still holds a process after its conversation ends`, async () => {
      // The bug this guards: three call sites gated `reset()` on
      // `hasActiveConversation()`. A committed plan nulls the conversation
      // while the adapter still holds the agent process, so `destroy()`
      // disposed nothing and the process outlived the session.
      const before = descendants();
      const svc = liveService(agent);
      try {
        await svc.startConversation({
          goal: 'Reply with the single word OK. Do not use any tools and do not emit JSON.',
          runners: [agent],
          modelsByRunner: { [agent]: [] },
          fs: fakeFileSystem(),
          onProgress: () => {},
        });

        const spawned = descendants().filter((pid) => !before.includes(pid));
        expect(spawned.length, `${agent} spawned no process to leak`).toBeGreaterThan(0);

        svc.reset();
        for (let i = 0; i < 40 && descendants().some((pid) => spawned.includes(pid)); i++) {
          await new Promise((r) => setTimeout(r, 250));
        }
        const survivors = descendants().filter((pid) => spawned.includes(pid));
        expect(survivors, `${agent} processes outlived reset(): ${survivors.join(', ')}`).toEqual([]);
      } finally {
        svc.reset();
      }
    }, TIMEOUT_MS);
  }
});
