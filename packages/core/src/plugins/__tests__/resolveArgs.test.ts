import { describe, it, expect } from 'vitest';
import { resolveArgs, ResolveError } from '../resolveArgs';
import { CODEX_MANIFEST } from '../builtin/codex.manifest';
import type { RunnerPluginManifest, ResolveContext } from '../types';

function basicManifest(overrides?: Partial<RunnerPluginManifest>): RunnerPluginManifest {
  return {
    name: 'test',
    displayName: 'Test',
    description: 'Test manifest',
    version: '1.0.0',
    runner: {
      command: 'test-cli',
      argsTemplate: ['{{prompt}}'],
      promptInArgs: true,
    },
    features: {
      modelSelection: false,
      thinkingEffort: false,
      planMode: false,
      planModeFlag: '',
    },
    modelDiscovery: {
      method: 'hardcoded',
      fallbackModels: [],
    },
    ...overrides,
  };
}

function ctx(overrides?: Partial<ResolveContext>): ResolveContext {
  return { prompt: 'do the thing', mode: 'build', ...overrides };
}

describe('resolveArgs', () => {
  it('resolves a simple manifest', () => {
    const result = resolveArgs(basicManifest(), ctx());
    expect(result.command).toBe('test-cli');
    expect(result.args).toEqual(['do the thing']);
    expect(result.promptInArgs).toBe(true);
  });

  it('injects model when present', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--model', '{{model}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ model: 'gpt-4' }));
    expect(result.args).toEqual(['--model', 'gpt-4', 'do the thing']);
  });

  it('without conditional, a missing model token becomes empty and is filtered', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--model', '{{model}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ model: undefined }));
    // --model is a literal so it still appears; {{model}} resolves to '' and is dropped
    expect(result.args).toEqual(['--model', 'do the thing']);
  });

  it('resolves thinking effort', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--thinking', '{{thinkingEffort}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ thinkingEffort: 'high' }));
    expect(result.args).toEqual(['--thinking', 'high', 'do the thing']);
  });

  it('resolves mode token', () => {
    const m = basicManifest({
      runner: { command: 'c', argsTemplate: ['--agent', '{{mode}}', '{{prompt}}'], promptInArgs: true },
      features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
    });
    const result = resolveArgs(m, ctx({ mode: 'plan' }));
    expect(result.args).toEqual(['--agent', 'plan', 'do the thing']);
  });

  describe('conditional blocks', () => {
    it('includes {{if model}} block when model is set', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '--model', '{{model}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: 'claude-3' }));
      expect(result.args).toContain('--model');
      expect(result.args).toContain('claude-3');
    });

    it('skips {{if model}} block when model is not set', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '--model', '{{model}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: undefined }));
      expect(result.args).not.toContain('--model');
      expect(result.args).toEqual(['do the thing']);
    });

    it('includes {{if thinking}} block when thinking + model', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if thinking}}', '--thinking', 'on', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: 'high', model: 'm' }));
      expect(result.args).toContain('--thinking');
    });

    it('skips {{if thinking}} block without thinking effort', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if thinking}}', '--thinking', 'on', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: undefined, model: 'm' }));
      expect(result.args).not.toContain('--thinking');
    });

    it('includes {{if planMode}} block in plan mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if planMode}}', '--read-only', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ mode: 'plan' }));
      expect(result.args).toContain('--read-only');
    });

    it('skips {{if planMode}} block in build mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if planMode}}', '--read-only', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ mode: 'build' }));
      expect(result.args).not.toContain('--read-only');
    });

    it('includes {{if buildMode}} block in build mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if buildMode}}', '--write', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ mode: 'build' }));
      expect(result.args).toContain('--write');
    });

    it('includes {{if headless}} block when headless + not plan mode', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if headless}}', '--yes', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '', headlessFlag: '--yes' },
      });
      const result = resolveArgs(m, ctx({ headless: true, mode: 'build' }));
      expect(result.args).toContain('--yes');
    });

    it('skips {{if headless}} block in plan mode even with headless', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if headless}}', '--yes', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '', headlessFlag: '--yes' },
      });
      const result = resolveArgs(m, ctx({ headless: true, mode: 'plan' }));
      expect(result.args).not.toContain('--yes');
    });
  });

  describe('feature tokens', () => {
    it('resolves {{feature:thinkingFlags}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:thinkingFlags}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '',
          thinkingFlag: '--thinking',
        },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: 'high', model: 'm' }));
      expect(result.args).toEqual(['--thinking', 'enabled', '--effort', 'high', 'do the thing']);
    });

    it('resolves {{feature:thinkingVal}} for high', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['--thinking', '{{feature:thinkingVal}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: true, planMode: false, planModeFlag: '',
          thinkingValueEnabled: 'enabled',
          thinkingValueDisabled: 'disabled',
          thinkingValueAdaptive: 'adaptive',
        },
      });
      const result = resolveArgs(m, ctx({ thinkingEffort: 'high', model: 'm' }));
      expect(result.args).toEqual(['--thinking', 'enabled', 'do the thing']);
    });

    it('resolves {{feature:permissionModeVal}} from manifest map', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['--perm', '{{feature:permissionModeVal}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '',
          permissionModeValues: { build: 'acceptEdits', plan: 'plan' },
        },
      });
      const result = resolveArgs(m, ctx({ mode: 'build' }));
      expect(result.args).toEqual(['--perm', 'acceptEdits', 'do the thing']);
    });

    it('resolves {{feature:permissionModeVal}} with fallback to mode id', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['--perm', '{{feature:permissionModeVal}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '',
          // no permissionModeValues map — falls back to mode id
        },
      });
      const result = resolveArgs(m, ctx({ mode: 'plan' }));
      expect(result.args).toEqual(['--perm', 'plan', 'do the thing']);
    });

    it('resolves {{feature:headless}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:headless}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '',
          headlessFlag: '--skip-perms',
        },
      });
      const result = resolveArgs(m, ctx({ headless: true }));
      expect(result.args).toEqual(['--skip-perms', 'do the thing']);
    });

    it('resolves {{feature:planMode}} and {{feature:buildMode}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:planMode}}', '{{feature:buildMode}}', '{{prompt}}'], promptInArgs: true },
        features: {
          modelSelection: false, thinkingEffort: false, planMode: true, planModeFlag: '--plan',
          buildModeFlag: '--build',
        },
      });
      const result = resolveArgs(m, ctx());
      expect(result.args).toEqual(['--plan', '--build', 'do the thing']);
    });

    it('resolves unknown {{feature:*}} tokens to empty string', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{feature:unknown}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx());
      expect(result.args).toEqual(['do the thing']);
    });
  });

  describe('env substitution', () => {
    it('substitutes variables in env block', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { MODEL: '{{model}}', MODE: '{{mode}}' },
        },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: 'gpt-4' }));
      expect(result.env).toEqual({ MODEL: 'gpt-4', MODE: 'build' });
    });

    it('keeps an {{if}} env block when the condition holds', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { CONFIG: '{{if thinking}}{"model":"{{model}}","variant":"{{thinkingEffort}}"}{{/if}}' },
        },
        features: { modelSelection: true, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: 'p/m', thinkingEffort: 'high' }));
      expect(result.env).toEqual({ CONFIG: '{"model":"p/m","variant":"high"}' });
    });

    it('omits an env entry whose {{if}} condition fails instead of exporting an empty string', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { CONFIG: '{{if thinking}}{"variant":"{{thinkingEffort}}"}{{/if}}' },
        },
        features: { modelSelection: true, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      // {{if thinking}} requires model AND thinkingEffort — model alone is not enough
      expect(resolveArgs(m, ctx({ model: 'p/m' })).env).toEqual({});
      expect(resolveArgs(m, ctx({ thinkingEffort: 'high' })).env).toEqual({});
    });

    it('omits env entries that resolve to empty even without conditionals', () => {
      const m = basicManifest({
        runner: {
          command: 'c',
          argsTemplate: ['{{prompt}}'],
          promptInArgs: true,
          env: { MODEL: '{{model}}', MODE: '{{mode}}' },
        },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      const result = resolveArgs(m, ctx({ model: undefined }));
      expect(result.env).toEqual({ MODE: 'build' });
    });
  });

  describe('error handling', () => {
    it('throws on nested conditional blocks', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '{{if thinking}}', 'nested', '{{/if}}', '{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: true, planMode: false, planModeFlag: '' },
      });
      expect(() => resolveArgs(m, ctx({ model: 'm', thinkingEffort: 'high' }))).toThrow(ResolveError);
    });

    it('throws on unmatched {{/if}}', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{/if}}', '{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      expect(() => resolveArgs(m, ctx())).toThrow(ResolveError);
    });

    it('throws on unclosed conditional block', () => {
      const m = basicManifest({
        runner: { command: 'c', argsTemplate: ['{{if model}}', '--model', '{{model}}'], promptInArgs: true },
        features: { modelSelection: true, thinkingEffort: false, planMode: false, planModeFlag: '' },
      });
      expect(() => resolveArgs(m, ctx({ model: 'm' }))).toThrow(ResolveError);
    });
  });
});

describe('resolveArgs — Codex manifest', () => {
  it('headless build task: exec subcommand, model, effort config override, workspace-write sandbox', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', model: 'gpt-5.6-sol', thinkingEffort: 'high', headless: true,
    });
    expect(result.command).toBe('codex');
    expect(result.args).toEqual([
      'exec', '--skip-git-repo-check',
      '-m', 'gpt-5.6-sol',
      '-c', 'model_reasoning_effort=high',
      '--sandbox', 'workspace-write',
      'do it',
    ]);
  });

  it('interactive task: no exec subcommand, same model/effort/sandbox flags', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'do it', mode: 'agent', model: 'gpt-5.6-terra', thinkingEffort: 'ultra', headless: false,
    });
    expect(result.args).toEqual([
      '-m', 'gpt-5.6-terra',
      '-c', 'model_reasoning_effort=ultra',
      '--sandbox', 'workspace-write',
      'do it',
    ]);
  });

  it('plan mode maps to the read-only sandbox', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'analyze', mode: 'plan', model: 'gpt-5.5', headless: true,
    });
    expect(result.args).toEqual([
      'exec', '--skip-git-repo-check',
      '-m', 'gpt-5.5',
      '--sandbox', 'read-only',
      'analyze',
    ]);
  });

  it('fullAccess mode maps to danger-full-access', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'go', mode: 'fullAccess', model: 'gpt-5.6-sol', headless: true,
    });
    expect(result.args).toContain('--sandbox');
    expect(result.args).toContain('danger-full-access');
  });

  it('omits the effort config pair when no thinking effort is set', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'go', mode: 'agent', model: 'gpt-5.4', headless: true,
    });
    expect(result.args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('legacy build mode id aliases to workspace-write', () => {
    const result = resolveArgs(CODEX_MANIFEST, {
      prompt: 'go', mode: 'build', model: 'gpt-5.4', headless: true,
    });
    expect(result.args).toContain('workspace-write');
  });
});
