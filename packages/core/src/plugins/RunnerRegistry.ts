import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type { RunnerPluginManifest, PluginEntry, IPluginStore } from './types';
import { FsPluginStore } from './FsPluginStore';
import { CLAUDE_CODE_MANIFEST } from './builtin/claude-code.manifest';
import { CODEX_MANIFEST } from './builtin/codex.manifest';
import { OPENCODE_MANIFEST } from './builtin/opencode.manifest';
import type { IConfig } from '../interfaces/IConfig';

// Insertion order is picker order on every surface (registry.list() preserves it).
const BUILTIN_MANIFESTS: RunnerPluginManifest[] = [
  CLAUDE_CODE_MANIFEST,
  CODEX_MANIFEST,
  OPENCODE_MANIFEST,
];

export class RunnerRegistry {
  private plugins: Map<string, PluginEntry> = new Map();
  private store: IPluginStore;

  constructor(store?: IPluginStore) {
    this.store = store ?? new FsPluginStore();
    this.loadBuiltins();
  }

  private loadBuiltins(): void {
    for (const manifest of BUILTIN_MANIFESTS) {
      this.plugins.set(manifest.name, { manifest, source: 'builtin' });
    }
  }

  loadUserPlugins(): void {
    const names = this.store.listUserPluginDirs();
    for (const name of names) {
      const pluginDir = path.join(this.store.getUserPluginsDir(), name);
      const manifest = this.store.loadManifest(pluginDir);
      if (!manifest) continue;
      this.plugins.set(manifest.name, {
        manifest,
        source: 'user',
        installPath: pluginDir,
      });
    }
  }

  get(id: string): PluginEntry | undefined {
    return this.plugins.get(id);
  }

  getManifest(id: string): RunnerPluginManifest | undefined {
    return this.plugins.get(id)?.manifest;
  }

  list(): PluginEntry[] {
    return [...this.plugins.values()];
  }

  listEnabled(config: IConfig): PluginEntry[] {
    const enabled = config.enabledRunners;
    return this.list().filter((p) => enabled.includes(p.manifest.name));
  }

  listEnabledIds(config: IConfig): string[] {
    return this.listEnabled(config).map((p) => p.manifest.name);
  }

  isBuiltIn(id: string): boolean {
    const entry = this.plugins.get(id);
    return entry?.source === 'builtin';
  }

  installFromPath(sourcePath: string): RunnerPluginManifest {
    const absPath = path.resolve(sourcePath);
    if (!this.store.dirExists(absPath)) {
      throw new Error(`Plugin source must be a directory: ${absPath}`);
    }

    const manifest = this.store.loadManifest(absPath);
    if (!manifest) {
      throw new Error(`No valid manifest.json found in: ${absPath}`);
    }

    const destDir = path.join(this.store.getUserPluginsDir(), manifest.name);
    this.store.ensureDir(destDir);
    this.store.copyDir(absPath, destDir);

    this.plugins.set(manifest.name, {
      manifest,
      source: 'user',
      installPath: destDir,
    });

    return manifest;
  }

  installFromGit(url: string): RunnerPluginManifest {
    const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'plugin';
    const tmpDir = path.join(os.tmpdir(), `ordewell-plugin-${Date.now()}`);
    this.store.ensureDir(tmpDir);

    try {
      execSync(`git clone --depth 1 "${url}" "${tmpDir}"`, { stdio: 'pipe', timeout: 30000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to clone repository: ${message}`);
    }

    const contents = fsReaddirSync(tmpDir);
    const hasManifest = contents.some((f) => f === 'manifest.json');

    if (!hasManifest && contents.length === 1 && this.store.dirExists(path.join(tmpDir, contents[0]))) {
      const subDir = path.join(tmpDir, contents[0]);
      return this.finishInstall(subDir, repoName, tmpDir);
    }

    if (!hasManifest) {
      this.store.removeDir(tmpDir);
      throw new Error(`No manifest.json found in repository: ${url}`);
    }

    return this.finishInstall(tmpDir, repoName, tmpDir);
  }

  private finishInstall(sourceDir: string, repoName: string, tmpDir: string): RunnerPluginManifest {
    const manifest = this.store.loadManifest(sourceDir);
    if (!manifest) {
      this.store.removeDir(tmpDir);
      throw new Error(`No valid manifest.json found in cloned repository`);
    }

    const destDir = path.join(this.store.getUserPluginsDir(), manifest.name);
    this.store.ensureDir(destDir);
    this.store.copyDir(sourceDir, destDir);
    this.store.removeDir(tmpDir);

    this.plugins.set(manifest.name, {
      manifest,
      source: 'user',
      installPath: destDir,
    });

    return manifest;
  }

  remove(name: string): void {
    const entry = this.plugins.get(name);
    if (!entry) throw new Error(`Plugin not found: ${name}`);
    if (entry.source === 'builtin') throw new Error(`Cannot remove built-in plugin: ${name}`);

    if (entry.installPath) {
      try {
        this.store.removeDir(entry.installPath);
      } catch { /* ignore cleanup errors */ }
    }

    this.plugins.delete(name);
  }

  createSkeleton(name: string, outputDir: string): string {
    const dir = path.resolve(outputDir, name);
    this.store.ensureDir(dir);

    const manifest: RunnerPluginManifest = {
      name,
      displayName: name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description: `Custom runner plugin: ${name}`,
      version: '0.1.0',
      runner: {
        command: 'bash',
        argsTemplate: [
          '{{if model}}', '--model', '{{model}}', '{{/if}}',
          '--prompt', '{{prompt}}',
        ],
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
        fallbackModels: [
          { modelId: 'gpt-4o', modelLabel: 'GPT-4o' },
        ],
      },
    };

    this.store.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const runSh = path.join(dir, 'run.sh');
    const scriptContent = `#!/usr/bin/env bash
# Custom runner script for ${name}
# Receives:
#   $1 = prompt text
#   $2 = model ID (optional)
#
# This script should invoke your desired CLI tool with the prompt.
# Replace the echo below with your actual command.

prompt="$1"
model="$2"

echo "Running ${name} with prompt: $prompt"
# Example: your-cli-tool --message "$prompt"
`;
    this.store.writeFile(runSh, scriptContent);
    try { fsChmodSync(runSh, 0o755); } catch { /* ignore */ }

    return dir;
  }
}

function fsReaddirSync(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function fsChmodSync(fpath: string, mode: number): void {
  try {
    fs.chmodSync(fpath, mode);
  } catch { /* ignore */ }
}
