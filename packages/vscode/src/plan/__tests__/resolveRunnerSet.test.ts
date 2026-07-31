import { describe, it, expect } from 'vitest';
import { resolveRunnerSet, type PlanManagerDeps } from '../PlanManager';
import type { LegacyPlanState, RunnerId } from '@ordewell/core';
import type { VsCodeConfig } from '../../adapters/VsCodeConfig';
import type { RunnerRegistry } from '@ordewell/core';
import type { ChatViewProvider } from '../../providers/ChatViewProvider';

function depsWith(enabledRunners: RunnerId[], planRunners: RunnerId[] = ['claude-code']): PlanManagerDeps {
  const plan: LegacyPlanState = {
    tasks: [],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: planRunners,
    lastUpdated: new Date().toISOString(),
  };
  return {
    config: { enabledRunners } as unknown as VsCodeConfig,
    pluginRegistry: {
      get: (id: string) => id === 'claude-code' || id === 'opencode',
    } as unknown as RunnerRegistry,
    chatProvider: { showError: () => {} } as unknown as ChatViewProvider,
    getCurrentPlan: () => plan,
  } as unknown as PlanManagerDeps;
}

describe('resolveRunnerSet', () => {
  it('uses pendingRunners when provided and valid', () => {
    const deps = depsWith(['claude-code', 'opencode']);
    expect(resolveRunnerSet(deps, ['claude-code'])).toEqual(['claude-code']);
  });

  it('uses pendingRunners when both are selected', () => {
    const deps = depsWith(['claude-code', 'opencode']);
    expect(resolveRunnerSet(deps, ['claude-code', 'opencode'])).toEqual(['claude-code', 'opencode']);
  });

  it('falls back to currentPlanRunners when pendingRunners is undefined', () => {
    const deps = depsWith(['claude-code', 'opencode'], ['claude-code']);
    expect(resolveRunnerSet(deps, undefined, ['claude-code'])).toEqual(['claude-code']);
  });

  it('falls back to currentPlanRunners when pendingRunners is empty', () => {
    const deps = depsWith(['claude-code', 'opencode'], ['claude-code']);
    expect(resolveRunnerSet(deps, [], ['claude-code'])).toEqual(['claude-code']);
  });

  it('does NOT expand to all enabled runners when pendingRunners is missing', () => {
    const deps = depsWith(['claude-code', 'opencode'], ['claude-code']);
    const result = resolveRunnerSet(deps, undefined, ['claude-code']);
    expect(result).toEqual(['claude-code']);
    expect(result).not.toContain('opencode');
  });

  it('falls back to all enabled only when both pendingRunners and currentPlanRunners are missing', () => {
    const deps = depsWith(['claude-code', 'opencode'], ['claude-code']);
    expect(resolveRunnerSet(deps, undefined, undefined)).toEqual(['claude-code', 'opencode']);
  });

  it('filters pendingRunners by enabled list', () => {
    const deps = depsWith(['claude-code']);
    expect(resolveRunnerSet(deps, ['claude-code', 'opencode'])).toEqual(['claude-code']);
  });

  it('filters currentPlanRunners by enabled list', () => {
    const deps = depsWith(['claude-code']);
    expect(resolveRunnerSet(deps, undefined, ['claude-code', 'opencode'])).toEqual(['claude-code']);
  });

  it('returns null and shows error when no runners are enabled', () => {
    const deps = depsWith([], []);
    expect(resolveRunnerSet(deps, ['claude-code'])).toBeNull();
  });

  it('falls through to all enabled when pendingRunners has no valid entries and currentPlanRunners is missing', () => {
    const deps = depsWith(['claude-code', 'opencode'], ['claude-code']);
    expect(resolveRunnerSet(deps, ['nonexistent'], undefined)).toEqual(['claude-code', 'opencode']);
  });
});
