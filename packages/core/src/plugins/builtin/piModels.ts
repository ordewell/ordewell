import type { DiscoveredModel } from '../../models/Task';
import type { RunnerManifest } from '../types';

/**
 * Pi's thinking levels (`--thinking`), offered on a model whose catalog row
 * says it thinks. Pi clamps a level to what the model supports.
 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * A token count as Pi prints it: `32.8K`, `1M`, or a plain number. Pi rounds
 * to one decimal, so `32.8K` is 32,800, not the 32,768 the model reports.
 */
function tokenCount(text: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([KM]?)$/i.exec(text ?? '');
  if (!m) return undefined;
  const unit = m[2].toUpperCase();
  const n = Math.round(Number(m[1]) * (unit === 'M' ? 1_000_000 : unit === 'K' ? 1_000 : 1));
  return n > 0 ? n : undefined;
}

/**
 * Parse `pi --list-models`: a table headed
 * `provider  model  context  max-out  thinking  images`, one row per model of a
 * provider that has credentials. A Pi with none prints "No models available"
 * and exits 0, which reads as no models. Ids are `provider/model`.
 */
export function parsePiModels(stdout: string, _manifest: RunnerManifest): DiscoveredModel[] {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const header = lines.findIndex((l) => /^provider\s+model\s+context\b/i.test(l));
  if (header < 0) return [];

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const line of lines.slice(header + 1)) {
    const [provider, model, context, maxOut, thinking] = line.split(/\s+/);
    if (!provider || !model || thinking === undefined) continue;
    const modelId = `${provider}/${model}`;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    const contextWindow = tokenCount(context);
    const maxOutputTokens = tokenCount(maxOut);
    models.push({
      modelId,
      modelLabel: model,
      runnerProvider: provider,
      variants: thinking === 'yes' ? THINKING_LEVELS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) : [],
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  }
  return models;
}
