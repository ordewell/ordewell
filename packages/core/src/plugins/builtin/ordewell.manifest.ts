import type { AiProvider } from '../../interfaces/IConfig';
import { VENDORS } from '../../services/apiProviders';
import { PROVIDER_RUNNER_IDS } from '../../services/providerRunners';
import type { RunnerManifest, RunnerMode } from '../types';

/** The runner's modes (ADR-0070), each enforced by Ordewell itself: the runner has no permission system of its own. */
export const ORDEWELL_FULL_MODE = 'full';
export const ORDEWELL_GUARDED_MODE = 'guarded';
export const ORDEWELL_READ_ONLY_MODE = 'read-only';

// The tags are what ModeResolver maps the plan's levels onto: Full is the
// autonomous mode, Guarded the safe one, and a read-only task the readOnly one.
export const ORDEWELL_MODES: readonly RunnerMode[] = [
  { id: ORDEWELL_FULL_MODE, label: 'Full', description: 'Edits and shell commands run without asking; edits stay in the worktree and the shell holds no provider keys', autonomous: true },
  { id: ORDEWELL_GUARDED_MODE, label: 'Guarded', description: 'Reads and edits in the worktree go ahead; every shell command waits for approval', safe: true },
  { id: ORDEWELL_READ_ONLY_MODE, label: 'Read-only', description: 'No edit, write or shell tools; the only shell is the sealed run_command', readOnly: true },
];

/**
 * Ordewell's own coding agent on one provider (ADR-0070), under that
 * provider's id and name. It has no command: the loop runs in the Ordewell
 * process and calls the provider's API with the key Ordewell holds for it, so
 * it is installed wherever that provider is configured. Its models are that
 * provider's catalog, as `<provider>:<model>`.
 */
export function ordewellManifest(provider: AiProvider): RunnerManifest {
  return {
    name: provider,
    displayName: VENDORS[provider].label,
    runner: { inProcess: true, provider },
    features: {},
    modelDiscovery: { method: 'providers' },
    contextFile: 'AGENTS.md',
    contextFileAltPath: 'CLAUDE.md',
    modes: [...ORDEWELL_MODES],
  };
}

/** One per provider, in provider priority order. */
export const ORDEWELL_MANIFESTS: readonly RunnerManifest[] = PROVIDER_RUNNER_IDS.map(ordewellManifest);
