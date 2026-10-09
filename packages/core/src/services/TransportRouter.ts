import type { ITerminalRunner, ITerminalSession, RunnerTransport } from '../interfaces/ITerminalRunner';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerSpawnOptions } from './AbstractRunner';
import { supportsTaskMode, takesOrdewellTools } from './harness/connectors';

export interface TransportRoute {
  transport: RunnerTransport;
  /** Why a structured request runs on the terminal instead, in words a surface shows as is. */
  fallback?: string;
}

/**
 * Where one task runs (ADR-0018, S3): structured only when the attempt asks for
 * it and the task's runner has a task-mode connector. Anything else runs on
 * the terminal, and a structured request says why.
 */
export function routeTransport(requested: RunnerTransport | undefined, runner: string, registry?: RunnerRegistry | null): TransportRoute {
  if (requested !== 'structured') return { transport: 'terminal' };
  if (supportsTaskMode(runner)) return { transport: 'structured' };
  const name = registry?.get(runner)?.manifest.displayName ?? runner;
  return { transport: 'terminal', fallback: `no structured connector for ${name} yet` };
}

/**
 * Whether a task routed this way is given the `task_complete` tool (ADR-0022):
 * on the structured transport, by a connector that injects the server.
 */
export function givesCompletionTool(requested: RunnerTransport | undefined, runner: string, registry?: RunnerRegistry | null): boolean {
  return routeTransport(requested, runner, registry).transport === 'structured' && takesOrdewellTools(runner);
}

/**
 * The runner a host hands the orchestrator: its own terminal runner (tmux,
 * headless, the VS Code terminal) and the structured one behind a single
 * `ITerminalRunner`, picking per spawn by {@link routeTransport}.
 *
 * `stopAll` and `activeCount` reach both inner runners, so a host that shares
 * one across plans (the daemon's tmux) keeps its per-plan wrapper above this.
 */
export class TransportRouter implements ITerminalRunner {
  /**
   * Session ids the structured runner owns; every other id is the terminal's.
   * Kept past exit, so a stop that arrives late never reaches the terminal
   * runner with an id it does not know.
   */
  private readonly structuredIds = new Set<string>();

  constructor(private readonly runners: { terminal: ITerminalRunner; structured: ITerminalRunner }) {}

  get activeCount(): number {
    return this.runners.terminal.activeCount + this.runners.structured.activeCount;
  }

  async spawn(opts: RunnerSpawnOptions): Promise<ITerminalSession> {
    if (routeTransport(opts.transport, opts.runner, opts.registry).transport === 'terminal') {
      return this.runners.terminal.spawn(opts);
    }
    const session = await this.runners.structured.spawn(opts);
    this.structuredIds.add(session.id);
    return session;
  }

  stop(sessionId: string): void {
    if (this.structuredIds.delete(sessionId)) this.runners.structured.stop(sessionId);
    else this.runners.terminal.stop(sessionId);
  }

  stopAll(): void {
    this.structuredIds.clear();
    this.runners.structured.stopAll();
    this.runners.terminal.stopAll();
  }
}
