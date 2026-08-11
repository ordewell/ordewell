import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import type { RunnerPluginManifest, PluginEntry, IPluginStore } from './types';
import { FsPluginStore } from './FsPluginStore';
import { CLAUDE_CODE_MANIFEST } from './builtin/claude-code.manifest';
import { CODEX_MANIFEST } from './builtin/codex.manifest';
import { OPENCODE_MANIFEST } from './builtin/opencode.manifest';
import { assertPlainPluginName, isPlainPluginName, resolvePluginInstallDir } from './pluginNames';
import { assertInstallablePluginUrl } from './pluginSource';
import type { IConfig } from '../interfaces/IConfig';

// Insertion order is picker order on every surface (registry.list() preserves it).
const BUILTIN_MANIFESTS: RunnerPluginManifest[] = [
  CLAUDE_CODE_MANIFEST,
  CODEX_MANIFEST,
  OPENCODE_MANIFEST,
];

const RESERVED_RUNNER_NAMES = new Set(BUILTIN_MANIFESTS.map((m) => m.name.toLowerCase()));

/** True when a name belongs to a built-in runner and is therefore not installable. */
export function isReservedRunnerName(name: string): boolean {
  return RESERVED_RUNNER_NAMES.has(name.toLowerCase());
}

/** Clone seam: takes a validated URL and a destination, or throws. */
export type PluginCloneFn = (url: string, destDir: string) => void;

function gitClone(url: string, destDir: string): void {
  // Argument vector, not a shell string, so nothing in the URL is interpreted;
  // `--` additionally stops git reading a dash-prefixed URL as a flag.
  execFileSync('git', ['clone', '--depth', '1', '--', url, destDir], {
    stdio: 'pipe',
    timeout: 30000,
    // A repository that demands credentials should fail, not hang on a prompt.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

export class RunnerRegistry {
  private plugins: Map<string, PluginEntry> = new Map();
  private store: IPluginStore;
  private clone: PluginCloneFn;

  constructor(store?: IPluginStore, clone?: PluginCloneFn) {
    this.store = store ?? new FsPluginStore();
    this.clone = clone ?? gitClone;
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
      let pluginDir: string;
      try {
        pluginDir = resolvePluginInstallDir(this.store.getUserPluginsDir(), name);
      } catch {
        continue;
      }
      const manifest = this.store.loadManifest(pluginDir);
      if (!manifest || !isPlainPluginName(manifest.name)) continue;
      // Built-in names are reserved: a user plugin must never take over a
      // built-in runner's spawn command and argument template.
      if (isReservedRunnerName(manifest.name)) continue;
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

    return this.registerInstalled(manifest, absPath);
  }

  installFromGit(url: string): RunnerPluginManifest {
    // Validated here rather than in the command-line front end, so callers of
    // the exported install function get the same protection.
    const validated = assertInstallablePluginUrl(url);
    // Random rather than timestamped: on a shared /tmp a predictable name lets
    // someone else own the directory the clone lands in.
    const tmpDir = path.join(os.tmpdir(), `ordewell-plugin-${randomBytes(12).toString('hex')}`);
    this.store.ensureDir(tmpDir);

    try {
      try {
        this.clone(validated.toString(), tmpDir);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to clone repository: ${message}`);
      }

      const contents = this.store.listDir(tmpDir);
      const hasManifest = contents.some((f) => f === 'manifest.json');

      let sourceDir = tmpDir;
      if (!hasManifest) {
        const onlyEntry = contents.length === 1 ? path.join(tmpDir, contents[0]) : undefined;
        if (!onlyEntry || !this.store.dirExists(onlyEntry)) {
          throw new Error(`No manifest.json found in repository: ${validated.toString()}`);
        }
        sourceDir = onlyEntry;
      }

      const manifest = this.store.loadManifest(sourceDir);
      if (!manifest) {
        throw new Error('No valid manifest.json found in cloned repository');
      }

      return this.registerInstalled(manifest, sourceDir);
    } finally {
      this.store.removeDir(tmpDir);
    }
  }

  /**
   * The single destination-building step both install routes share: the name is
   * constrained to a plain segment and the resolved destination is asserted to
   * be inside the plugins directory before anything is copied.
   */
  private registerInstalled(manifest: RunnerPluginManifest, sourceDir: string): RunnerPluginManifest {
    if (isReservedRunnerName(manifest.name)) {
      throw new Error(`Cannot install a plugin named after a built-in runner: ${manifest.name}`);
    }

    const destDir = resolvePluginInstallDir(this.store.getUserPluginsDir(), manifest.name);
    this.store.ensureDir(destDir);
    this.store.copyDir(sourceDir, destDir);

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
    assertPlainPluginName(name);
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

function fsChmodSync(fpath: string, mode: number): void {
  try {
    fs.chmodSync(fpath, mode);
  } catch { /* ignore */ }
}
