import { describe, it, expect } from 'vitest';
import { isPlainPluginName, resolvePluginInstallDir } from '../pluginNames';
import { isValidManifest } from '../manifestValidation';

const validManifest = (name: unknown) => ({
  name,
  displayName: 'X',
  description: 'X',
  version: '1.0.0',
  runner: { command: 'x', argsTemplate: ['{{prompt}}'], promptInArgs: true },
  features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
  modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
});

describe('isPlainPluginName', () => {
  it.each(['my-runner', 'runner', 'a', 'my_runner', 'my.runner', 'Runner9'])(
    'accepts %s',
    (name) => expect(isPlainPluginName(name)).toBe(true),
  );

  it.each([
    '..',
    '.',
    '../evil',
    '../../etc/cron.d/x',
    'a/b',
    'a\\b',
    '/abs',
    '-rf',
    '.hidden',
    'trailing-',
    'with space',
    'nul\u0000byte',
    '',
    'x'.repeat(65),
  ])('rejects %j', (name) => expect(isPlainPluginName(name)).toBe(false));

  it('rejects non-strings', () => {
    expect(isPlainPluginName(undefined)).toBe(false);
    expect(isPlainPluginName(42)).toBe(false);
  });
});

describe('isValidManifest', () => {
  it('accepts a complete manifest with a plain name', () => {
    expect(isValidManifest(validManifest('my-runner'))).toBe(true);
  });

  it('rejects a manifest whose name is a traversal sequence', () => {
    expect(isValidManifest(validManifest('../../../tmp/evil'))).toBe(false);
    expect(isValidManifest(validManifest('..'))).toBe(false);
  });

  it('rejects a manifest whose name is absolute or dash-prefixed', () => {
    expect(isValidManifest(validManifest('/etc/ordewell'))).toBe(false);
    expect(isValidManifest(validManifest('--upload-pack'))).toBe(false);
  });

  it('still rejects manifests missing required fields', () => {
    expect(isValidManifest({})).toBe(false);
    expect(isValidManifest({ ...validManifest('ok'), runner: null })).toBe(false);
  });
});

describe('resolvePluginInstallDir', () => {
  it('resolves a plain name to a direct child of the plugins directory', () => {
    expect(resolvePluginInstallDir('/test/plugins', 'my-runner')).toBe('/test/plugins/my-runner');
  });

  it.each(['..', '../evil', '../../etc', 'a/b', '/etc/passwd'])(
    'refuses to resolve %j',
    (name) => expect(() => resolvePluginInstallDir('/test/plugins', name)).toThrow(),
  );
});
