import { IFileSystem } from '../interfaces/IFileSystem';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';

export interface CollectedContext {
  agentConfig: string | null;
  agentConfigPath: string | null;
  dirStructure: string | null;
  aiflowContext: string | null;
}

const ORDEWELL_CONTEXT_MAX = 8000;

/**
 * The project-context preamble every planner backend puts in front of its
 * system prompt: ORDEWELL.md, each runner's own agent config, and the directory
 * structure. Lives here rather than on a service base class because both
 * transports need it and only one of them has a base class (ADR-0009).
 */
export async function collectResearchContext(fs: IFileSystem, runners: string[]): Promise<string> {
  const collector = new ContextCollector(fs);

  let contextStr = '';
  let firstContext: CollectedContext | null = null;
  for (const r of runners) {
    const ctx = await collector.collect(r);
    if (!firstContext) firstContext = ctx;
    if (ctx.agentConfig && ctx.agentConfigPath) {
      contextStr += `\n=== ${ctx.agentConfigPath} (${r}) ===\n${ctx.agentConfig.slice(0, 3000)}\n`;
    }
  }
  if (firstContext?.aiflowContext) {
    contextStr = `\n<aiflow_context>\n${firstContext.aiflowContext}\n</aiflow_context>\n` + contextStr;
  }
  if (firstContext?.dirStructure) contextStr += `\n=== Directory Structure ===\n${firstContext.dirStructure}\n`;
  return contextStr;
}

export class ContextCollector {
  constructor(private fs: IFileSystem, private registry?: RunnerRegistry) {}

  setRegistry(registry: RunnerRegistry): void {
    this.registry = registry;
  }

  async collect(runner: string): Promise<CollectedContext> {
    const context: CollectedContext = {
      agentConfig: null,
      agentConfigPath: null,
      dirStructure: null,
      aiflowContext: null,
    };

    const aiflowResult = await this.readIfExists('ORDEWELL.md');
    if (aiflowResult) context.aiflowContext = aiflowResult.output.slice(0, ORDEWELL_CONTEXT_MAX);

    const plugin = this.registry?.getManifest(runner);
    if (plugin?.contextFile) {
      const configResult = await this.readIfExists(plugin.contextFile)
        || (plugin.contextFileAltPath ? await this.readIfExists(plugin.contextFileAltPath) : null);
      if (configResult) {
        context.agentConfig = configResult.output;
        context.agentConfigPath = plugin.contextFile;
      }
    }

    const dirResult = await this.fs.listDir('.', 3);
    if (dirResult.success) context.dirStructure = dirResult.output;

    return context;
  }

  private async readIfExists(filePath: string) {
    const result = await this.fs.readFile(filePath);
    if (result.success && result.output.length > 0) return result;
    return null;
  }
}
