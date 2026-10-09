import type { RunnerManifest, RunnerEntry } from './types';
import { CLAUDE_CODE_MANIFEST } from './builtin/claude-code.manifest';
import { CODEX_MANIFEST } from './builtin/codex.manifest';
import { OPENCODE_MANIFEST } from './builtin/opencode.manifest';
import type { IConfig } from '../interfaces/IConfig';

// Insertion order is picker order on every surface.
const BUILTIN_MANIFESTS: RunnerManifest[] = [
  CLAUDE_CODE_MANIFEST,
  CODEX_MANIFEST,
  OPENCODE_MANIFEST,
];

export class RunnerRegistry {
  private readonly runners = new Map<string, RunnerEntry>(
    BUILTIN_MANIFESTS.map((manifest) => [manifest.name, { manifest }]),
  );

  get(id: string): RunnerEntry | undefined {
    return this.runners.get(id);
  }

  getManifest(id: string): RunnerManifest | undefined {
    return this.get(id)?.manifest;
  }

  list(): RunnerEntry[] {
    return [...this.runners.values()];
  }

  listEnabled(config: IConfig): RunnerEntry[] {
    return this.list().filter((entry) => config.enabledRunners.includes(entry.manifest.name));
  }

  listEnabledIds(config: IConfig): string[] {
    return this.listEnabled(config).map((entry) => entry.manifest.name);
  }
}
