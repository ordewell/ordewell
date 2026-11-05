import { describe, it, expect } from 'vitest';
import { plannerBackendEntries, HARNESS_PLANNER_REASON, HARNESS_PLANNER_UNAVAILABLE_REASON, type PlannerUsability } from '../ProviderRegistry';
import { VENDORS } from '../apiProviders';
import { CONNECTORS } from '../harness/connectors';
import { BUILTIN_MANIFESTS } from '../../plugins/builtin';

describe('plannerBackendEntries', () => {
  it('lists harness planners first, then configured vendors in PROVIDER_PRIORITY order', () => {
    const entries = plannerBackendEntries({}, ['anthropic', 'openrouter']);
    expect(entries.map((e) => e.id)).toEqual([
      'claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent', 'openrouter', 'anthropic',
    ]);
    expect(entries.map((e) => e.kind)).toEqual([
      'harness', 'harness', 'harness', 'harness', 'harness', 'harness', 'harness', 'harness', 'vendor', 'vendor',
    ]);
  });

  it('labels harness planners with the no-key reason and their runner when usable', () => {
    const usable = (): PlannerUsability => ({ usable: true });
    const entries = plannerBackendEntries(
      { 'claude-code': usable(), codex: usable(), opencode: usable() },
      [],
    );
    const claude = entries[0];
    expect(claude).toMatchObject({
      id: 'claude-code', label: 'Claude Code', kind: 'harness',
      runner: 'claude-code', usable: true, reason: HARNESS_PLANNER_REASON,
    });
    expect(entries.map((e) => e.runner)).toEqual(['claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent']);
  });

  it('keeps an unusable harness planner listed with the reason it was given', () => {
    const entries = plannerBackendEntries(
      { codex: { usable: false, reason: 'codex is not installed or is not on PATH.' } },
      [],
    );
    const codex = entries.find((e) => e.id === 'codex')!;
    expect(codex).toMatchObject({ usable: false, reason: 'codex is not installed or is not on PATH.' });
  });

  it('treats a runner absent from the usability map as unusable, with an accurate reason', () => {
    const codex = plannerBackendEntries({}, []).find((e) => e.id === 'codex')!;
    expect(codex.usable).toBe(false);
    expect(codex.reason).toBe(HARNESS_PLANNER_UNAVAILABLE_REASON);
  });

  it('keeps a signed-out harness planner offered, carrying the verdict and its login as the reason', () => {
    const auth = { state: 'signed-out' as const, loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
    const claude = plannerBackendEntries({ 'claude-code': { usable: true, auth } }, [])
      .find((e) => e.id === 'claude-code')!;

    expect(claude.usable).toBe(true);
    expect(claude.auth).toEqual(auth);
    expect(claude.reason).toBe('not logged in');
  });

  it('carries a signed-in verdict without changing the usual no-key reason', () => {
    const auth = { state: 'signed-in' as const, loginCommand: ['claude', 'auth', 'login'] };
    const claude = plannerBackendEntries({ 'claude-code': { usable: true, auth } }, [])
      .find((e) => e.id === 'claude-code')!;

    expect(claude.auth).toEqual(auth);
    expect(claude.reason).toBe(HARNESS_PLANNER_REASON);
  });

  it('offers vendors with their API-key variable as the reason, always usable', () => {
    const vendors = plannerBackendEntries({}, ['openrouter', 'google'])
      .filter((e) => e.kind === 'vendor');
    expect(vendors).toEqual([
      { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true, reason: 'OPENROUTER_API_KEY' },
      { id: 'google', label: 'Google Gemini', kind: 'vendor', usable: true, reason: 'GEMINI_API_KEY' },
    ]);
  });

  it('lists only the harness planners when nothing is configured', () => {
    const entries = plannerBackendEntries({}, []);
    expect(entries.every((e) => e.kind === 'harness')).toBe(true);
    expect(entries).toHaveLength(8);
  });
});

describe('the planner backend id space', () => {
  // A runner that can plan is a backend under its runner id, beside the
  // vendors: one sharing a vendor's id would replace it in ALL_PROVIDERS, and a
  // runner that cannot plan yet would on the day it can.
  it('gives no runner a vendor\'s id', () => {
    const runners = new Set([...BUILTIN_MANIFESTS.map((manifest) => manifest.name), ...Object.keys(CONNECTORS)]);

    expect(runners).toContain('copilot-cli');
    expect(Object.keys(VENDORS).filter((vendor) => runners.has(vendor))).toEqual([]);
  });
});
