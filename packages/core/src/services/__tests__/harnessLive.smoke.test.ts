import { spawn } from 'child_process';
import { describe, it, expect } from 'vitest';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { AiProvider } from '../../interfaces/IConfig';
import type { ResearchStep } from '../../models/Task';

/**
 * The opt-in live check, one per agent (ADR-0009, M11).
 *
 * These run the real CLIs against the real workspace, so they are NOT part of
 * the suite: each turn costs subscription quota and tens of seconds, cannot run
 * in CI without credentials, and a rate-limited account would be a red build
 * that is not a real failure. Recorded fixtures carry the suite; this exists to
 * catch schema drift deliberately rather than through a user's bug report.
 *
 *   ORDEWELL_LIVE_AGENTS=claude-code,codex,opencode \
 *     npx vitest run --root packages/core harnessLive
 *
 * What it asserts stops short of judging the model: the transport works, the
 * agent actually reaches the workspace, a refusal does not hang the turn, and
 * the plan it emits validates. Anything about the *content* of the plan would
 * be a test of the model, not of the adapter.
 */

const requested = (process.env.ORDEWELL_LIVE_AGENTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Generous on purpose. A harness turn is a whole agent session — cold start,
 * exploration, several model round-trips — and an agent working around a
 * problem (a refused tool, a sandbox that will not start) spends minutes doing
 * it. A tighter bound would report the machine as a transport failure.
 */
const TIMEOUT_MS = 420_000;

function liveService(provider: AiProvider) {
  return new CliAgentAiService(
    fakeConfig({ aiProvider: provider, enabledRunners: [provider] }),
    { spawn, workspaceRoot: () => process.cwd() },
  );
}

describe.runIf(requested.length > 0)('harness planners — live smoke', () => {
  for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
    it.runIf(requested.includes(agent))(`${agent} reads the workspace and answers`, async () => {
      const svc = liveService(agent);
      const steps: ResearchStep[] = [];
      try {
        const turn = await svc.startConversation({
          goal: 'Read README.md in this workspace and reply with one short sentence naming its first heading. Do not emit any JSON.',
          runners: [agent],
          modelsByRunner: { [agent]: [] },
          fs: fakeFileSystem(),
          onProgress: (p) => { if (p.step) steps.push(p.step); },
        });

        expect(turn.kind).toBe('message');
        expect(turn.text.trim().length).toBeGreaterThan(0);
        // An agent that answers without touching a file is answering from
        // memory: a broken sandbox, a clobbered tool prompt, or a refusal
        // nobody surfaced. That produces confident, uninformed plans, which is
        // the failure this assertion exists to make loud.
        expect(steps.length, `${agent} answered without running a single tool`).toBeGreaterThan(0);
        // Specifically a *local* tool. Reaching the network still counts as a
        // successful call, so counting any success let a Codex with a broken
        // sandbox pass this by web-searching for a file it could not open.
        const local = steps.filter((s) => s.tool !== 'web_search' && s.tool !== 'fetch');
        expect(local.some((s) => s.outcome === 'success'), `no ${agent} tool call reached the workspace: ${steps.map((s) => `${s.toolLabel ?? s.tool}=${s.outcome}`).join(', ')}`).toBe(true);
      } finally {
        svc.reset();
      }
    }, TIMEOUT_MS);

    it.runIf(requested.includes(agent))(`${agent} survives a tool it is not allowed to use`, async () => {
      // Each agent has at least one way to block on a human — an interactive
      // question, a permission prompt, a path outside the workspace. All of
      // them must come back denied, and the turn must still settle.
      const svc = liveService(agent);
      try {
        const turn = await svc.startConversation({
          goal: 'Read the file /etc/hostname, which is outside this workspace, and then tell me in one sentence whether you managed it.',
          runners: [agent],
          modelsByRunner: { [agent]: [] },
          fs: fakeFileSystem(),
          onProgress: () => {},
        });

        expect(turn.kind).toBe('message');
        expect(turn.text.trim().length).toBeGreaterThan(0);
      } finally {
        svc.reset();
      }
    }, TIMEOUT_MS);

    it.runIf(requested.includes(agent))(`${agent} generates a plan the validator accepts`, async () => {
      const svc = liveService(agent);
      try {
        const { tasks } = await svc.researchAndPlan(
          'Add one unit test for the smallest exported function in this repository. Emit the plan JSON immediately, without asking anything.',
          [agent],
          { [agent]: [] },
          fakeFileSystem(),
          () => {},
        );

        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks[0].assignedRunner).toBe(agent);
        expect(tasks[0].prompt?.trim().length).toBeGreaterThan(0);
      } finally {
        svc.reset();
      }
    }, TIMEOUT_MS);
  }
});
