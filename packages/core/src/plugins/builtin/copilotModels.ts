import type { DiscoveredModel } from '../../models/Task';
import type { RunnerManifest } from '../types';

const MODEL_SETTING = /^\s*`model`:/;
const LISTED_VALUE = /^\s+- "([^"]+)"\s*$/;

/**
 * The models `copilot help config` lists under its `model` setting, the only
 * catalog the CLI prints. The list ends at the blank line before the next
 * setting. It is Copilot's whole catalog, not what this account may use, so a
 * listed model can still be refused when a task runs.
 */
export function parseCopilotModels(output: string, _manifest: RunnerManifest): DiscoveredModel[] {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => MODEL_SETTING.test(line));
  if (start < 0) return [];
  const models: DiscoveredModel[] = [];
  for (const line of lines.slice(start + 1)) {
    const listed = LISTED_VALUE.exec(line);
    if (!listed) break;
    models.push({ modelId: listed[1], modelLabel: listed[1], variants: [] });
  }
  return models;
}
