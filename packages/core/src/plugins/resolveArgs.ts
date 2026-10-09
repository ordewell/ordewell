import type { RunnerManifest } from './types';
import type { TaskRunnerFlags } from '../services/harness/AgentAdapter';

export function claudeThinkingArgs(effort: string): string[] {
  if (effort === 'disabled') return ['--thinking', 'disabled'];
  if (effort === 'adaptive') return ['--thinking', 'adaptive'];
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    return ['--thinking', 'enabled', '--effort', effort];
  }
  // Saved tasks may predate the current effort IDs.
  return ['--thinking', 'adaptive'];
}

function modeId(mode: string | undefined): string {
  return mode || 'default';
}

function permissionModeValue(manifest: RunnerManifest, mode: string | undefined): string {
  const id = modeId(mode);
  const map = manifest.features.permissionModeValues;
  if (map && map[id] !== undefined) return map[id];
  return id;
}

export function resolveModeSettings(manifest: RunnerManifest, mode: string | undefined): Record<string, string> {
  const id = modeId(mode);
  const settings: Record<string, string> = {};
  for (const [setting, byMode] of Object.entries(manifest.features.modeSettings ?? {})) {
    if (byMode[id] !== undefined) settings[setting] = byMode[id];
  }
  return settings;
}

export function resolveTaskRunnerFlags(
  manifest: RunnerManifest,
  ctx: { mode: string; model?: string; thinkingEffort?: string },
): TaskRunnerFlags {
  const flags: TaskRunnerFlags = {
    permissionMode: permissionModeValue(manifest, ctx.mode),
    modeSettings: resolveModeSettings(manifest, ctx.mode),
  };
  if (ctx.model && ctx.thinkingEffort) flags.effort = ctx.thinkingEffort;
  return flags;
}
