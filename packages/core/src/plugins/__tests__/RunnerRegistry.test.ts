import { describe, it, expect } from 'vitest';
import { RunnerRegistry } from '../RunnerRegistry';
import type { IConfig } from '../../interfaces/IConfig';

const config = (enabledRunners: string[]) => ({ enabledRunners }) as IConfig;

describe('RunnerRegistry', () => {
  it('lists only built-ins in picker order', () => {
    const registry = new RunnerRegistry();
    expect(registry.list().map((entry) => entry.manifest.name)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(registry.getManifest('claude-code')?.runner.command).toBe('claude');
    expect(registry.get('codex')?.manifest).toBe(registry.getManifest('codex'));
  });

  it('does not resolve removed or unknown runners', () => {
    const registry = new RunnerRegistry();
    for (const id of ['custom-runner', 'toString', '__proto__', '']) {
      expect(registry.get(id)).toBeUndefined();
      expect(registry.getManifest(id)).toBeUndefined();
    }
  });

  it('filters enabled runners against built-ins, retaining picker order', () => {
    const registry = new RunnerRegistry();
    expect(registry.listEnabledIds(config(['custom-runner', 'opencode', 'claude-code']))).toEqual(['claude-code', 'opencode']);
    expect(registry.listEnabled(config([]))).toEqual([]);
  });
});
