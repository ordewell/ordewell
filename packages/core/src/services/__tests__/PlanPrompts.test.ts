import { describe, it, expect } from 'vitest';
import { buildConversationSystemPrompt, buildResearchPrompt, buildResearchToolsPrompt, buildSubagentSystemPrompt } from '../PlanPrompts';
import type { DiscoveredModel, RunnerId } from '../../models/Task';

import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';

const modes = (over: Partial<PlannerModes> = {}): PlannerModes => ({ ...DEFAULT_PLANNER_MODES, ...over });

describe('buildConversationSystemPrompt grill-me (aligned with the original grill-me skill)', () => {
  function prompt(grillMeEnabled: boolean, prdEnabled = false, reviewEnabled = false) {
    return buildConversationSystemPrompt(
      'build a task planner',
      '',
      {},
      ['claude-code'],
      undefined,
      true,
      grillMeEnabled,
      prdEnabled,
      reviewEnabled,
    );
  }

  it('instructs a relentless interview until shared understanding, walking the decision tree', () => {
    const p = prompt(true);
    expect(p).toMatch(/Interview the user relentlessly about every aspect of their goal until you reach a shared understanding/i);
    expect(p).toMatch(/Walk down each branch of the design tree/i);
    expect(p).toMatch(/resolving dependencies between decisions one-by-one/i);
  });

  it('asks one question at a time and proposes a recommended answer, like the original skill', () => {
    const p = prompt(true);
    expect(p).toMatch(/Ask one question at a time, waiting for the user's answer before continuing/i);
    expect(p).toMatch(/propose your recommended answer/i);
    expect(p).toMatch(/Asking multiple questions at once is bewildering/i);
  });

  it('prefers exploring the codebase over asking when a fact is answerable that way', () => {
    const p = prompt(true);
    expect(p).toMatch(/If a fact can be found by exploring the codebase, look it up instead of asking/i);
  });

  it('has no minimum-questions floor — the model decides when understanding is reached', () => {
    const p = prompt(true);
    expect(p).not.toMatch(/at least \d+ probing questions/i);
    expect(p).not.toMatch(/explicitly justify why fewer questions are needed/i);
  });

  it('requires explicit user confirmation before transitioning to outline or JSON', () => {
    const p = prompt(true);
    expect(p).toMatch(/Only propose an outline after the user has answered enough questions/i);
    expect(p).toMatch(/wait for explicit confirmation before emitting the task plan JSON/i);
  });

  it('uses no sentinel tokens for phase transitions', () => {
    const p = prompt(true);
    expect(p).not.toContain('<<ORDEWELL_QUESTION>>');
    expect(p).not.toContain('READY_FOR_PRD');
  });

  it('gates the grill-me block with the toggle', () => {
    const on = prompt(true);
    const off = prompt(false);
    expect(on).toContain('INTERVIEW MODE');
    expect(off).not.toContain('INTERVIEW MODE');
  });
});

describe('buildConversationSystemPrompt review mode', () => {
  function prompt(reviewEnabled: boolean) {
    return buildConversationSystemPrompt(
      'build a task planner',
      '',
      {},
      ['claude-code'],
      undefined,
      true,
      false,
      false,
      reviewEnabled,
    );
  }

  it('adds a review task block when reviewEnabled is true', () => {
    const p = prompt(true);
    expect(p).toContain('REVIEW MODE:');
    expect(p).toMatch(/Add a FINAL review task to the end of the plan/i);
    expect(p).toMatch(/type "ai" and use the STRONGEST available model/i);
    expect(p).toMatch(/dependencies on ALL other AI\/user tasks/i);
  });

  it('produces a structured review report instruction', () => {
    const p = prompt(true);
    expect(p).toMatch(/Review every completed task's outputs and verify the original goal was met/i);
    expect(p).toMatch(/structured review report/i);
    expect(p).toMatch(/PASS\/FAIL conclusion with evidence/i);
  });

  it('gates the review block with the toggle', () => {
    const on = prompt(true);
    const off = prompt(false);
    expect(on).toContain('REVIEW MODE');
    expect(off).not.toContain('REVIEW MODE');
  });

  it('reviews on two separately-reported axes: spec conformance and standards', () => {
    const p = prompt(true);
    expect(p).toContain('SPEC axis:');
    expect(p).toContain('STANDARDS axis:');
    expect(p).toMatch(/reported SEPARATELY so one cannot mask the other/i);
    expect(p).toMatch(/scope creep/i);
    expect(p).toMatch(/Quote the PRD line for each finding/i);
    expect(p).toMatch(/always judgement calls, never hard failures/i);
    expect(p).toMatch(/documented repo standards override the baseline/i);
  });
});

describe('buildConversationSystemPrompt verification mode', () => {
  function prompt(verificationEnabled: boolean, reviewEnabled = false) {
    return buildConversationSystemPrompt(
      'build a task planner',
      '',
      {},
      ['claude-code'],
      undefined,
      true,
      false,
      false,
      reviewEnabled,
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

  it('orders verification before review when both modes are active', () => {
    const p = prompt(true, true);
    expect(p).toContain('REVIEW MODE:');
    expect(p).toMatch(/verification task immediately before the review task/i);
    expect(p).toMatch(/review task keeps the highest order number and must list the verification task among its dependencies/i);
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

describe('buildConversationSystemPrompt PRD mode', () => {
  function prompt(prdEnabled: boolean) {
    return buildConversationSystemPrompt(
      'build a task planner',
      '',
      {},
      ['claude-code'],
      undefined,
      true,
      false,
      prdEnabled,
      false,
    );
  }

  it('applies seam economy to the previewed testing seams', () => {
    const p = prompt(true);
    expect(p).toMatch(/Prefer existing seams over new ones/i);
    expect(p).toMatch(/the ideal number is one/i);
  });

  it('constrains PRD content: extensive user stories, decisions, no file paths', () => {
    const p = prompt(true);
    expect(p).toMatch(/As an <actor>, I want <feature>, so that <benefit>/i);
    expect(p).toMatch(/do NOT include specific file paths or code snippets/i);
    expect(p).toMatch(/snippet from a prototype that encodes a decision/i);
  });

  it('gates the PRD block with the toggle', () => {
    const on = prompt(true);
    const off = prompt(false);
    expect(on).toContain('PRD MODE');
    expect(off).not.toContain('PRD MODE');
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
  it('tools prompt mentions spawn_research_agent only when subagents are enabled', () => {
    expect(buildResearchToolsPrompt()).not.toContain('spawn_research_agent');
    const on = buildResearchToolsPrompt(true);
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
  function variant(harnessMode: boolean, toggles: { grillMe?: boolean; prd?: boolean; review?: boolean; verify?: boolean } = {}) {
    return buildConversationSystemPrompt(
      'build a task planner',
      'PROJECT CONTEXT HERE',
      { 'claude-code': [{ modelId: 'sonnet', modelLabel: 'Sonnet', variants: [{ id: 'high', label: 'High' }] }] },
      ['claude-code'],
      undefined,
      true,
      toggles.grillMe ?? false,
      toggles.prd ?? false,
      toggles.review ?? false,
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

  it('carries every mode-toggle block, so no toggle works on one backend only', () => {
    const all = { grillMe: true, prd: true, review: true, verify: true };
    const harness = variant(true, all);
    const api = variant(false, all);

    for (const block of ['INTERVIEW MODE — GRILL-ME:', 'PRD MODE:', 'REVIEW MODE:', 'VERIFICATION MODE:']) {
      expect(harness).toContain(block);
      expect(api).toContain(block);
    }
    // The two variants differ only in the research-phase block.
    expect(harness.replace(/RESEARCH PHASE:[\s\S]*?\n\n/, '')).toEqual(api.replace(/RESEARCH PHASE:[\s\S]*?\n\n/, ''));
  });
});
