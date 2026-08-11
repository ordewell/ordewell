import type { RunnerPluginManifest } from './types';
import { isPlainPluginName } from './pluginNames';

/**
 * Shape check for a manifest read off disk or out of a cloned repository. The
 * name is constrained here rather than at each install route, so every store
 * implementation gets the same guarantee that a manifest name is a plain
 * segment and never a traversal sequence.
 */
export function isValidManifest(obj: unknown): obj is RunnerPluginManifest {
  if (!obj || typeof obj !== 'object') return false;
  const m = obj as Record<string, unknown>;
  return (
    isPlainPluginName(m.name) &&
    typeof m.displayName === 'string' &&
    typeof m.description === 'string' &&
    typeof m.version === 'string' &&
    typeof m.runner === 'object' && m.runner !== null &&
    typeof (m.runner as Record<string, unknown>).command === 'string' &&
    Array.isArray((m.runner as Record<string, unknown>).argsTemplate) &&
    typeof m.features === 'object' && m.features !== null &&
    typeof m.modelDiscovery === 'object' && m.modelDiscovery !== null
  );
}
