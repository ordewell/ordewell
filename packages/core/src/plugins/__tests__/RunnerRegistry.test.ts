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
