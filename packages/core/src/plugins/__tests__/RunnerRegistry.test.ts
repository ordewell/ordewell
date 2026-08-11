import { describe, it, expect, beforeEach } from 'vitest';
import { RunnerRegistry } from '../RunnerRegistry';
import { InMemoryPluginStore } from './InMemoryPluginStore';
import type { RunnerPluginManifest } from '../types';

describe('RunnerRegistry', () => {
  let store: InMemoryPluginStore;

  beforeEach(() => {
    store = new InMemoryPluginStore();
  });

  it('loads built-in plugins on construction', () => {
    const reg = new RunnerRegistry(store);
    const list = reg.list();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.find((p) => p.manifest.name === 'claude-code')).toBeDefined();
    expect(list.find((p) => p.manifest.name === 'codex')).toBeDefined();
    expect(list.find((p) => p.manifest.name === 'opencode')).toBeDefined();
    expect(list.every((p) => p.source === 'builtin')).toBe(true);
  });

  it('lists built-ins in picker order: Claude Code, Codex, OpenCode', () => {
    const reg = new RunnerRegistry(store);
    const builtinNames = reg.list().filter((p) => p.source === 'builtin').map((p) => p.manifest.name);
    expect(builtinNames).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('loads user plugins from store', () => {
    const reg = new RunnerRegistry(store);
    store.setFile(
      `${store.getUserPluginsDir()}/my-runner/manifest.json`,
      JSON.stringify({
        name: 'my-runner',
        displayName: 'My Runner',
        description: 'Test plugin',
        version: '0.1.0',
        runner: { command: 'mycli', argsTemplate: ['{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
        modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
      }),
    );
    store.addPluginDir('my-runner');

    reg.loadUserPlugins();
    expect(reg.get('my-runner')).toBeDefined();
    expect(reg.get('my-runner')!.source).toBe('user');
  });

  it('skips invalid manifest files without crashing', () => {
    const reg = new RunnerRegistry(store);
    store.setFile(`${store.getUserPluginsDir()}/broken/manifest.json`, 'not json');
    store.addPluginDir('broken');
    store.setFile(`${store.getUserPluginsDir()}/valid/manifest.json`, '{}');
    store.addPluginDir('valid');

    reg.loadUserPlugins();
    // neither should be loaded (broken=invalid json, valid=incomplete manifest)
    expect(reg.get('broken')).toBeUndefined();
    expect(reg.get('valid')).toBeUndefined();
  });

  it('installFromPath copies plugin and registers it', () => {
    const reg = new RunnerRegistry(store);
    const sourceDir = '/source/my-runner';
    store.setFile(
      `${sourceDir}/manifest.json`,
      JSON.stringify({
        name: 'my-runner',
        displayName: 'My Runner',
        description: 'Installed plugin',
        version: '1.0.0',
        runner: { command: 'tool', argsTemplate: ['{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
        modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
      }),
    );
    store.setFile(`${sourceDir}/run.sh`, '#!/bin/bash\necho "hello"');
    store.ensureDir(sourceDir);

    const result = reg.installFromPath(sourceDir);
    expect(result.name).toBe('my-runner');

    const entry = reg.get('my-runner');
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('user');
    expect(entry!.installPath).toBe(`${store.getUserPluginsDir()}/my-runner`);

    // Verify files were copied
    expect(store.exists(`${store.getUserPluginsDir()}/my-runner/manifest.json`)).toBe(true);
    expect(store.exists(`${store.getUserPluginsDir()}/my-runner/run.sh`)).toBe(true);
  });

  it('installFromPath throws when source is not a directory', () => {
    const reg = new RunnerRegistry(store);
    expect(() => reg.installFromPath('/nonexistent')).toThrow('must be a directory');
  });

  it('installFromPath throws when source has no manifest', () => {
    const reg = new RunnerRegistry(store);
    store.ensureDir('/no-manifest-dir');
    expect(() => reg.installFromPath('/no-manifest-dir')).toThrow('No valid manifest.json');
  });

  it('remove deletes a user plugin', () => {
    const reg = new RunnerRegistry(store);
    const sourceDir = '/source/to-remove';
    const manifest = {
      name: 'to-remove',
      displayName: 'To Remove',
      description: 'Will be removed',
      version: '1.0.0',
      runner: { command: 'x', argsTemplate: ['{{prompt}}'], promptInArgs: true },
      features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
      modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
    } satisfies RunnerPluginManifest;
    store.setFile(`${sourceDir}/manifest.json`, JSON.stringify(manifest));
    store.ensureDir(sourceDir);
    reg.installFromPath(sourceDir);
    expect(reg.get('to-remove')).toBeDefined();

    reg.remove('to-remove');
    expect(reg.get('to-remove')).toBeUndefined();
  });

  it('remove throws for built-in plugins', () => {
    const reg = new RunnerRegistry(store);
    expect(() => reg.remove('claude-code')).toThrow('Cannot remove built-in plugin');
  });

  it('createSkeleton writes manifest.json and run.sh', () => {
    const reg = new RunnerRegistry(store);
    const outputDir = '/output';
    store.ensureDir(outputDir);

    const dir = reg.createSkeleton('my-plugin', outputDir);
    expect(dir).toBe('/output/my-plugin');

    const manifestRaw = store.readFile(`${dir}/manifest.json`);
    expect(manifestRaw).not.toBeNull();
    const parsed = JSON.parse(manifestRaw!);
    expect(parsed.name).toBe('my-plugin');
    expect(parsed.runner.command).toBe('bash');

    const runSh = store.readFile(`${dir}/run.sh`);
    expect(runSh).not.toBeNull();
    expect(runSh!).toContain('#!/usr/bin/env bash');
  });

  it('get returns undefined for unknown id', () => {
    const reg = new RunnerRegistry(store);
    expect(reg.get('unknown')).toBeUndefined();
  });

  it('getManifest returns the manifest for a known plugin', () => {
    const reg = new RunnerRegistry(store);
    const m = reg.getManifest('claude-code');
    expect(m).toBeDefined();
    expect(m!.name).toBe('claude-code');
  });

  describe('install hardening', () => {
    const manifestJson = (name: string) => JSON.stringify({
      name,
      displayName: 'Evil',
      description: 'Test plugin',
      version: '1.0.0',
      runner: { command: 'x', argsTemplate: ['{{prompt}}'], promptInArgs: true },
      features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
      modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
    });

    /** Records what the clone would have been asked to do, and plants a repo. */
    function fakeClone(plant?: (destDir: string) => void) {
      const calls: { url: string; destDir: string }[] = [];
      const fn = (url: string, destDir: string) => {
        calls.push({ url, destDir });
        plant?.(destDir);
      };
      return { calls, fn };
    }

    it('installs from a validated https URL, passing the URL to the clone as an argument', () => {
      const clone = fakeClone((dest) => store.setFile(`${dest}/manifest.json`, manifestJson('good-runner')));
      const reg = new RunnerRegistry(store, clone.fn);

      const manifest = reg.installFromGit('https://github.com/user/repo.git');

      expect(manifest.name).toBe('good-runner');
      expect(clone.calls).toHaveLength(1);
      expect(clone.calls[0].url).toBe('https://github.com/user/repo.git');
      expect(reg.get('good-runner')!.installPath).toBe(`${store.getUserPluginsDir()}/good-runner`);
    });

    it('finds the manifest in a single top-level subdirectory of the clone', () => {
      const clone = fakeClone((dest) => store.setFile(`${dest}/pkg/manifest.json`, manifestJson('nested-runner')));
      const reg = new RunnerRegistry(store, clone.fn);

      expect(reg.installFromGit('https://github.com/user/repo.git').name).toBe('nested-runner');
    });

    it.each([
      'https://github.com/user/repo.git;touch /tmp/pwned',
      'https://github.com/user/$(touch /tmp/pwned)',
      'https://github.com/user/`id`',
      'git://evil.example/repo.git',
      'ext::sh -c "touch /tmp/pwned"',
      'https://evil.example/user/repo.git',
      '--upload-pack=touch /tmp/pwned',
    ])('installs nothing and clones nothing for %j', (url) => {
      const clone = fakeClone();
      const reg = new RunnerRegistry(store, clone.fn);

      expect(() => reg.installFromGit(url)).toThrow();
      expect(clone.calls).toHaveLength(0);
      expect(reg.list().every((p) => p.source === 'builtin')).toBe(true);
    });

    it('rejects a cloned manifest whose name would escape the plugins directory', () => {
      const clone = fakeClone((dest) => store.setFile(`${dest}/manifest.json`, manifestJson('../../../tmp/evil')));
      const reg = new RunnerRegistry(store, clone.fn);

      expect(() => reg.installFromGit('https://github.com/user/repo.git')).toThrow(/manifest/i);
      expect(store.exists('/tmp/evil/manifest.json')).toBe(false);
    });

    it('rejects a local-path manifest whose name would escape the plugins directory', () => {
      const reg = new RunnerRegistry(store);
      const sourceDir = '/source/evil';
      store.setFile(`${sourceDir}/manifest.json`, manifestJson('../../../tmp/evil'));
      store.ensureDir(sourceDir);

      expect(() => reg.installFromPath(sourceDir)).toThrow(/manifest/i);
      expect(store.exists('/tmp/evil/manifest.json')).toBe(false);
    });

    /**
     * The store is an injectable seam, so the registry cannot assume its
     * manifest validation ran. These prove the destination assert stands on its
     * own when a lenient store hands back a name the validator would refuse.
     */
    describe('with a store that does not validate manifests', () => {
      class LenientStore extends InMemoryPluginStore {
        loadManifest(pluginDir: string): RunnerPluginManifest | null {
          const raw = this.readFile(`${pluginDir}/manifest.json`);
          return raw ? (JSON.parse(raw) as RunnerPluginManifest) : null;
        }
      }

      it('asserts the destination is inside the plugins directory before copying', () => {
        const lenient = new LenientStore();
        const reg = new RunnerRegistry(lenient);
        const sourceDir = '/source/evil';
        lenient.setFile(`${sourceDir}/manifest.json`, manifestJson('../../../tmp/evil'));
        lenient.setFile(`${sourceDir}/payload.sh`, 'rm -rf ~');
        lenient.ensureDir(sourceDir);

        expect(() => reg.installFromPath(sourceDir)).toThrow(/Invalid plugin name/);
        expect(lenient.exists('/tmp/evil/payload.sh')).toBe(false);
      });

      it('applies the same assert on the clone route', () => {
        const lenient = new LenientStore();
        const clone = fakeCloneWith(lenient, '../../../tmp/evil');
        const reg = new RunnerRegistry(lenient, clone.fn);

        expect(() => reg.installFromGit('https://github.com/user/repo.git'))
          .toThrow(/Invalid plugin name/);
        expect(lenient.exists('/tmp/evil/manifest.json')).toBe(false);
      });

      function fakeCloneWith(target: InMemoryPluginStore, name: string) {
        const calls: { url: string; destDir: string }[] = [];
        return {
          calls,
          fn: (url: string, destDir: string) => {
            calls.push({ url, destDir });
            target.setFile(`${destDir}/manifest.json`, manifestJson(name));
          },
        };
      }
    });

    it('refuses to install a plugin named after a built-in runner', () => {
      const reg = new RunnerRegistry(store);
      const sourceDir = '/source/shadow';
      store.setFile(`${sourceDir}/manifest.json`, manifestJson('claude-code'));
      store.ensureDir(sourceDir);

      expect(() => reg.installFromPath(sourceDir)).toThrow(/built-in runner/i);
      expect(reg.get('claude-code')!.source).toBe('builtin');
    });

    it('refuses to install a built-in name over the git route too', () => {
      const clone = fakeClone((dest) => store.setFile(`${dest}/manifest.json`, manifestJson('codex')));
      const reg = new RunnerRegistry(store, clone.fn);

      expect(() => reg.installFromGit('https://github.com/user/repo.git')).toThrow(/built-in runner/i);
      expect(reg.get('codex')!.source).toBe('builtin');
    });

    it('does not let a user plugin directory shadow a built-in runner at load time', () => {
      const reg = new RunnerRegistry(store);
      const builtinCommand = reg.getManifest('claude-code')!.runner.command;
      store.setFile(`${store.getUserPluginsDir()}/claude-code/manifest.json`, manifestJson('claude-code'));
      store.addPluginDir('claude-code');

      reg.loadUserPlugins();

      expect(reg.get('claude-code')!.source).toBe('builtin');
      expect(reg.getManifest('claude-code')!.runner.command).toBe(builtinCommand);
    });

    it('skips a user plugin directory whose name is not a plain segment', () => {
      const reg = new RunnerRegistry(store);
      store.setFile('/test/manifest.json', manifestJson('escaped'));
      store.addPluginDir('../..');

      reg.loadUserPlugins();

      expect(reg.get('escaped')).toBeUndefined();
    });

    it('removes the clone directory even when the install is rejected', () => {
      const clone = fakeClone((dest) => store.setFile(`${dest}/manifest.json`, manifestJson('claude-code')));
      const reg = new RunnerRegistry(store, clone.fn);

      expect(() => reg.installFromGit('https://github.com/user/repo.git')).toThrow();
      expect(store.exists(`${clone.calls[0].destDir}/manifest.json`)).toBe(false);
    });

    it('createSkeleton refuses a name that is not a plain segment', () => {
      const reg = new RunnerRegistry(store);
      expect(() => reg.createSkeleton('../../evil', '/output')).toThrow(/Invalid plugin name/);
      expect(store.exists('/evil/manifest.json')).toBe(false);
    });
  });

  it('isBuiltIn returns true for builtins and false for user plugins', () => {
    const reg = new RunnerRegistry(store);
    expect(reg.isBuiltIn('claude-code')).toBe(true);

    const sourceDir = '/source/user-plugin';
    store.setFile(
      `${sourceDir}/manifest.json`,
      JSON.stringify({
        name: 'user-plugin',
        displayName: 'User Plugin',
        description: 'Test',
        version: '1.0.0',
        runner: { command: 'x', argsTemplate: ['{{prompt}}'], promptInArgs: true },
        features: { modelSelection: false, thinkingEffort: false, planMode: false, planModeFlag: '' },
        modelDiscovery: { method: 'hardcoded', fallbackModels: [] },
      }),
    );
    store.ensureDir(sourceDir);
    reg.installFromPath(sourceDir);
    expect(reg.isBuiltIn('user-plugin')).toBe(false);
  });
});
