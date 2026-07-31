import { describe, it, expect, vi } from 'vitest';
import { MODE_TOGGLES, DEFAULT_PLANNER_MODES, modesFor, plannerModesFrom, plannerRuntimeToggles, type PlannerModes } from '../plannerModes';
import type { UserSettings } from '../SettingsService';
import { buildPlanWithResults, buildResearchPrompt, buildConversationSystemPrompt } from '../PlanPrompts';
import { makeSession, fakeConfig } from './sessionTestKit';
import { sessionRuntimeSettings } from '../createSession';
import type { DiscoveredModel, RunnerId } from '../../models/Task';

const all: PlannerModes = {
  autonomousDefault: true,
  grillMe: true,
  prd: true,
  review: true,
  verification: true,
  researchSubagents: true,
};

describe('mode toggle registry', () => {
  it('gives every toggle exactly one settings key and at least one scope', () => {
    const ids = MODE_TOGGLES.map((t) => t.id);
    const keys = MODE_TOGGLES.map((t) => t.settingsKey);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const toggle of MODE_TOGGLES) expect(toggle.scopes.length).toBeGreaterThan(0);
  });

  it('keeps the one id that does not match its settings key declared in one place', () => {
    // `verify` on every surface, `verification` on disk. The translation used to
    // be hand-written in two files with a comment apologising for it.
    const verify = MODE_TOGGLES.find((t) => t.id === 'verify');
    expect(verify?.settingsKey).toBe('verification');
  });

  const settings: UserSettings = {
    grillMe: { enabled: true },
    tdd: { enabled: true },
    prd: { enabled: false },
    review: { enabled: true },
    verification: { enabled: false },
    researchSubagents: { enabled: true },
  };

  it('reads every toggle off the settings file, under its runtime name', () => {
    // Both hosts hand-mapped `getReview()` to `reviewEnabled` and friends, so a
    // toggle had three names — one on disk, one at runtime, one on screen — and
    // nothing tied them together. This is the tie.
    expect(plannerRuntimeToggles(settings)).toEqual({
      grillMeEnabled: true,
      tddEnabled: true,
      prdEnabled: false,
      reviewEnabled: true,
      verificationEnabled: false,
      researchSubagentsEnabled: true,
    });
  });

  it('carries the one field that is not a toggle alongside them', () => {
    // What a host actually needs. Stopping at the toggles left both hosts
    // spreading and appending `modelAllowlist` by hand — the same shape twice.
    expect(sessionRuntimeSettings({ ...settings, modelAllowlist: { opencode: ['a/b'] } })).toEqual({
      ...plannerRuntimeToggles(settings),
      modelAllowlist: { opencode: ['a/b'] },
    });
  });

  it('gives every toggle a runtime name of its own', () => {
    const runtime = MODE_TOGGLES.map((t) => t.runtimeKey);
    expect(new Set(runtime).size).toBe(runtime.length);
    // Whatever the assembler produces is exactly what the registry declares —
    // a toggle cannot be honoured on disk and forgotten at runtime.
    expect(Object.keys(plannerRuntimeToggles(settings)).sort()).toEqual([...runtime].sort());
  });

  it('drops the toggles a one-shot run cannot honour, and keeps the ones it can', () => {
    const scoped = modesFor('one-shot', all);

    // Both interview the user, and the one-shot prompt states there is nobody to ask.
    expect(scoped.grillMe).toBe(false);
    expect(scoped.prd).toBe(false);
    // Structural: they only shape the emitted plan.
    expect(scoped.review).toBe(true);
    expect(scoped.verification).toBe(true);
    expect(scoped.researchSubagents).toBe(true);
  });

  it('leaves the chat scope alone', () => {
    expect(modesFor('chat', all)).toEqual(all);
  });

  it('never invents a toggle the settings did not set', () => {
    expect(plannerModesFrom({}, true)).toEqual(DEFAULT_PLANNER_MODES);
  });
});

describe('the whole one-shot chain', () => {
  it('carries review from the settings file into the prompt the model receives', async () => {
    // Session → Planner → IAiService → PlanPrompts, with only the transport
    // faked. Each hop dropped review independently before; asserting on the
    // final prompt is the only way to know all of them carry it.
    let prompt = '';
    const aiService = {
      researchAndPlan: vi.fn(async (
        goal: string,
        runners: RunnerId[],
        modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
        _fs: unknown,
        _onProgress: unknown,
        _fetcher: unknown,
        runnerModes: undefined,
        modes: PlannerModes,
      ) => {
        prompt = buildResearchPrompt(goal, '', modelsByRunner, runners, runnerModes, modes);
        return { tasks: [], researchLog: [], researchResults: '' };
      }),
      hasActiveConversation: () => false,
      reset: vi.fn(),
    };

    const session = makeSession({
      config: fakeConfig({ researchEnabled: true }),
      settings: () => ({ tddEnabled: false, grillMeEnabled: true, prdEnabled: true, reviewEnabled: true }),
      aiService,
    });

    await session.generatePlan('add rate limiting', ['claude-code']);

    expect(aiService.researchAndPlan).toHaveBeenCalledOnce();
    expect(prompt).toContain('REVIEW MODE');
    expect(prompt).not.toContain('INTERVIEW MODE');
    expect(prompt).not.toContain('PRD MODE');
  });
});

describe('one-shot planner prompt', () => {
  const oneShot = (over: Partial<PlannerModes>) =>
    buildPlanWithResults('goal', '', '', {}, ['claude-code'], undefined, { ...DEFAULT_PLANNER_MODES, ...over });

  it('emits the review block, which it used to drop while the UI showed review ON', () => {
    expect(oneShot({ review: true })).toContain('REVIEW MODE');
  });

  it('omits the review block when review is off', () => {
    expect(oneShot({})).not.toContain('REVIEW MODE');
  });

  it('still omits the two toggles that need a user to talk to', () => {
    const research = buildResearchPrompt('goal', '', {}, ['claude-code'], undefined, {
      ...DEFAULT_PLANNER_MODES, grillMe: true, prd: true,
    });

    // The prompt tells the model there is nobody to ask; an interview block
    // here would be an instruction it cannot follow.
    expect(research).toContain('ONE-SHOT run');
    expect(research).not.toContain('INTERVIEW MODE');
    expect(research).not.toContain('PRD MODE');
    expect(oneShot({ grillMe: true, prd: true })).not.toContain('INTERVIEW MODE');
  });

  it('emits the same review text the conversation loop does', () => {
    const conversational = buildConversationSystemPrompt(
      'goal', '', {}, ['claude-code'], undefined, true, false, false, true, false,
    );
    const marker = 'Add a FINAL review task to the end of the plan (highest order number).';

    expect(conversational).toContain(marker);
    expect(oneShot({ review: true })).toContain(marker);
  });
});
