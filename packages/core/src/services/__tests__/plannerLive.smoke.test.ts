import { execFileSync, spawn } from 'child_process';
import { describe, it, expect } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { AiProvider } from '../../interfaces/IConfig';
import type { RunnerId } from '../../models/Task';

/**
 * The opt-in live check for the planner harness process lifecycle.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code,codex,opencode \
 *     npx vitest run --root packages/core plannerLive
 *
 * Not part of the suite: it costs real tokens and tens of seconds per case.
 */

const agents = (process.env.ORDEWELL_LIVE_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Generous because the bound is the provider's queue, not the work: the same
 * deepseek-v4-flash plan has come back in 30s and in 264s within an hour. A
 * tighter limit reports OpenRouter's load as a Ordewell failure.
 */
const TIMEOUT_MS = 600_000;

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
