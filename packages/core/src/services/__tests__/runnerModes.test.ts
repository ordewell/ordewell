import { describe, it, expect } from 'vitest';
import { runnerModesFrom } from '../ModeResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';

describe('runnerModesFrom', () => {
  it('reads each runner modes off its manifest', () => {
    const modes = runnerModesFrom(new RunnerRegistry(), ['codex', 'opencode']);

    expect(modes.codex.map((m) => m.id)).toEqual(['agent', 'plan', 'fullAccess']);
    expect(modes.opencode.map((m) => m.id)).toEqual(['build', 'plan']);
  });

  it('preserves manifest order, which is what a mode picker offers first', () => {
    const modes = runnerModesFrom(new RunnerRegistry(), ['claude-code']);

    expect(modes['claude-code'][0].id).toBe('default');
  });

  it('yields an empty list for a runner with no modes rather than omitting the key', () => {
    const registry = { getManifest: () => ({ name: 'aider' }) } as never;

    expect(runnerModesFrom(registry, ['aider'])).toEqual({ aider: [] });
  });

  it('yields an empty list for an unknown runner', () => {
    expect(runnerModesFrom(new RunnerRegistry(), ['nope'])).toEqual({ nope: [] });
  });
});
