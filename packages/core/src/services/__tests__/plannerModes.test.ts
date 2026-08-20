import { describe, it, expect } from 'vitest';
import { MODE_TOGGLES, DEFAULT_PLANNER_MODES, modesFor, plannerModesFrom, plannerRuntimeToggles, type PlannerModes } from '../plannerModes';
import type { UserSettings } from '../SettingsService';
import { buildResearchPrompt } from '../PlanPrompts';
import { sessionRuntimeSettings } from '../createSession';

const all: PlannerModes = {
  autonomousDefault: true,
  verification: true,
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
    tdd: { enabled: true },
    verification: { enabled: false },
  };

  it('reads every toggle off the settings file, under its runtime name', () => {
    // Both hosts hand-mapped `getVerification()` to `verificationEnabled` and
    // friends, so a toggle had three names — one on disk, one at runtime, one
    // on screen — and nothing tied them together. This is the tie.
    expect(plannerRuntimeToggles(settings)).toEqual({
      tddEnabled: true,
      verificationEnabled: false,
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

  it('drops verification outside the scopes it is declared for', () => {
    // `verify` is declared for `chat` and `one-shot` only — a `task` scope
    // (a runner task's own prompt) must not inherit it.
    expect(modesFor('task', all).verification).toBe(false);
    expect(modesFor('one-shot', all).verification).toBe(true);
  });

  it('leaves the chat scope alone', () => {
    expect(modesFor('chat', all)).toEqual(all);
  });

  it('never invents a toggle the settings did not set', () => {
    expect(plannerModesFrom({}, true)).toEqual(DEFAULT_PLANNER_MODES);
  });
});

describe('one-shot planner prompt', () => {
  it('tells the model there is nobody to ask', () => {
    const research = buildResearchPrompt('goal', '', {}, ['claude-code'], undefined, DEFAULT_PLANNER_MODES);

    expect(research).toContain('ONE-SHOT run');
  });
});
