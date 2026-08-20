import { describe, it, expect } from 'vitest';
import { buildConversationSystemPrompt, buildResearchPrompt, buildResearchToolsPrompt, buildSubagentSystemPrompt } from '../PlanPrompts';
import type { DiscoveredModel, RunnerId } from '../../models/Task';

import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';

const modes = (over: Partial<PlannerModes> = {}): PlannerModes => ({ ...DEFAULT_PLANNER_MODES, ...over });

describe('buildConversationSystemPrompt verification mode', () => {
  function prompt(verificationEnabled: boolean) {
    return buildConversationSystemPrompt(
      'build a task planner',
      '',
      {},
      ['claude-code'],
      undefined,
      true,
      verificationEnabled,
    );
  }

  it('adds an evidence-based AFK verification task block when enabled', () => {
    const p = prompt(true);
    expect(p).toContain('VERIFICATION MODE:');
    expect(p).toMatch(/Add a FINAL verification task to the end of the plan/i);
    expect(p).toMatch(/type "ai" and autonomy "AFK"/i);
    expect(p).toMatch(/dependencies on ALL other AI tasks/i);
    expect(p).toMatch(/commands and exit codes, never from judgement/i);
  });

  it('instructs feature-scope verification: full suite, spec walk, end-to-end', () => {
    const p = prompt(true);
    expect(p).toMatch(/Re-read the ORIGINAL goal/i);
    expect(p).toMatch(/full test suite and typecheck\/build/i);
    expect(p).toMatch(/requirement by requirement/i);
    expect(p).toMatch(/END-TO-END/);
    expect(p).toMatch(/integration gaps between task boundaries/i);
    expect(p).toMatch(/never skip, weaken, or delete a check/i);
  });

  it('falls back to a standalone verification script in repos with no test infrastructure', () => {
    const p = prompt(true);
    expect(p).toMatch(/NO test infrastructure/);
    expect(p).toMatch(/do not bootstrap a framework just for verification/i);
    expect(p).toMatch(/standalone verification script/i);
    expect(p).toMatch(/exits non-zero on any failed check/i);
  });

  it('gates the verification block with the toggle', () => {
    const on = prompt(true);
    const off = prompt(false);
    expect(on).toContain('VERIFICATION MODE');
    expect(off).not.toContain('VERIFICATION MODE');
  });

});

describe('buildResearchPrompt verification mode (one-shot path)', () => {
  function prompt(verificationEnabled: boolean) {
    return buildResearchPrompt(
      'build a task planner',
      '',
      {} as Partial<Record<RunnerId, DiscoveredModel[]>>,
      ['claude-code'],
      undefined,
      modes({ verification: verificationEnabled }),
    );
  }

  it('includes the verification block so headless `ordewell plan` gets the final task', () => {
    const p = prompt(true);
    expect(p).toContain('VERIFICATION MODE:');
    expect(p).toMatch(/Add a FINAL verification task to the end of the plan/i);
  });

  it('omits the block when disabled', () => {
    expect(prompt(false)).not.toContain('VERIFICATION MODE');
  });
});

describe('buildConversationSystemPrompt slice rules', () => {
  it('sizes slices to a fresh context window, prefactors first, and allows expand-contract for wide refactors', () => {
    const p = buildConversationSystemPrompt('goal', '', {}, ['claude-code']);
    expect(p).toMatch(/Size each slice to fit a single fresh agent session's context window/i);
    expect(p).toMatch(/make the change easy, then make the easy change/i);
    expect(p).toContain('EXPAND-CONTRACT');
  });
});

describe('buildResearchPrompt model catalog', () => {
  it('lists every discovered runner provider and each model\'s variants for the planner', () => {
    const modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> = {
      opencode: [
        { modelId: 'opencode/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro', runnerProvider: 'opencode', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
        { modelId: 'opencode/claude-sonnet-4', modelLabel: 'Claude Sonnet 4', runnerProvider: 'opencode', variants: [] },
      ],
      'opencode-go': [
        { modelId: 'opencode-go/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro (Go)', runnerProvider: 'opencode-go', variants: [{ id: 'low', label: 'Low' }] },
      ],
      openrouter: [
        { modelId: 'openrouter/~anthropic/claude-sonnet-latest', modelLabel: 'Claude Sonnet', runnerProvider: 'openrouter', variants: [] },
      ],
    };
    const p = buildResearchPrompt('goal', '', modelsByRunner, ['opencode'], undefined, modes());

    expect(p).toContain('opencode/deepseek-v4-pro');
    expect(p).toContain('"id": "low"');
    expect(p).toContain('"id": "high"');

    const pAll = buildResearchPrompt('goal', '', modelsByRunner, ['opencode', 'opencode-go', 'openrouter'], undefined, modes());
    expect(pAll).toContain('opencode-go/deepseek-v4-pro');
    expect(pAll).toContain('openrouter/~anthropic/claude-sonnet-latest');
  });
});

describe('research subagent prompts', () => {
  it('tools prompt always mentions spawn_research_agent', () => {
    const on = buildResearchToolsPrompt();
    expect(on).toContain('spawn_research_agent');
    // Concurrency guidance (opencode-style): batch spawn calls in one reply.
    expect(on).toMatch(/concurrent/i);
    // Small repos should not be pushed into fan-out.
    expect(on).toMatch(/small|single-subsystem/i);
  });

  it('subagent system prompt pins the read-only digest contract', () => {
    const p = buildSubagentSystemPrompt();
    expect(p).toMatch(/read-only/i);
    expect(p).toMatch(/digest/i);
    expect(p).toMatch(/file paths/i);
    // A subagent reports to the planner, not the user, and must not plan.
    expect(p).not.toContain('"tasks"');
  });
});

describe('buildConversationSystemPrompt harness variant (ADR-0009)', () => {
  function variant(harnessMode: boolean, toggles: { verify?: boolean } = {}) {
    return buildConversationSystemPrompt(
      'build a task planner',
      'PROJECT CONTEXT HERE',
      { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] }] },
      ['claude-code'],
      undefined,
      true,
      toggles.verify ?? false,
      harnessMode,
    );
  }

  it('drops the Ordewell tool names — a coding agent does not have them', () => {
    const harness = variant(true);
    expect(harness).not.toContain('list_dir');
    expect(harness).not.toContain('glob and grep');
    // The API variant still names them, because Ordewell is the one running them.
    expect(variant(false)).toContain('list_dir');
  });

  it('tells the harness planner in so many words that it must not touch the workspace', () => {
    const harness = variant(true);
    expect(harness).toMatch(/do NOT edit, create, or delete any file/i);
  });

  // A harness planner that backgrounds its exploration agents ends its turn on
  // "I'll report back once they land" — and the report, arriving after the turn
  // closed, reaches no one. The API planner runs its own agents inside the turn
  // and has nothing to be told.
  it('tells the harness planner to await its own agents inside the turn', () => {
    expect(variant(true)).toMatch(/WAIT for their results inside this reply/);
    expect(variant(false)).not.toMatch(/WAIT for their results inside this reply/);
  });

  it('keeps the plan schema, runner vocabulary and model catalog byte-identical', () => {
    const harness = variant(true);
    for (const shared of ['"tasks"', 'assignedRunner', 'assignedModel', 'sliceType', 'VERTICAL SLICE PLANNING', 'Sonnet', 'PROJECT CONTEXT HERE',
      // A subtask is a full task object with the same required fields. Dropping
      // this from one variant is exactly how the requirement went unstated.
      'at every depth']) {
      expect(harness).toContain(shared);
    }
  });

  it('teaches the task-query read protocol to both variants, so the channel is not API-only', () => {
    for (const prompt of [variant(true), variant(false)]) {
      expect(prompt).toContain('"taskQuery"');
      expect(prompt).toContain('"catalog"');
      expect(prompt).toContain('"fields"');
      // The point of the channel: read the body before rewriting it.
      expect(prompt).toMatch(/prompt|description/);
    }
  });

  it('carries the verification mode block, so the toggle works on both backends', () => {
    const all = { verify: true };
    const harness = variant(true, all);
    const api = variant(false, all);

    expect(harness).toContain('VERIFICATION MODE:');
    expect(api).toContain('VERIFICATION MODE:');
    // The two variants differ only in the research-phase block.
    expect(harness.replace(/RESEARCH PHASE:[\s\S]*?\n\n/, '')).toEqual(api.replace(/RESEARCH PHASE:[\s\S]*?\n\n/, ''));
  });
});
