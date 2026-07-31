import { exec } from 'child_process';
import { promisify } from 'util';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { augmentedPath, withPath } from '../utils/shellPath';
import { planDirectLaunch } from '../utils/launch';
import type { ExecImpl } from './ModelDiscovery';

const execAsync = promisify(exec);

// Installation checks must find `claude`/`opencode` wherever the user installed
// them, even under the minimal PATH a GUI-launched host inherits — same
// augmented-PATH rationale as ModelDiscovery.
const defaultExec: ExecImpl = async (command, options) => {
  const PATH = await augmentedPath();
  const { stdout } = await execAsync(command, { ...options, env: withPath(process.env, PATH) });
  return { stdout: String(stdout) };
};

const CHECK_TIMEOUT_MS = 8000;

/**
 * Runners with a harness-planner adapter (ADR-0009). Plugin runners are
 * deliberately absent: a manifest-level planner capability block, so user
 * plugins can declare themselves plannable, is a follow-up.
 */
const PLANNER_CAPABLE_RUNNERS = new Set(['claude-code', 'codex', 'opencode']);

/**
 * Detects whether a runner's underlying CLI is actually installed on the host,
 * by invoking `<command> --version`. Mirrors ModelDiscovery: injectable exec,
 * augmented PATH, per-process cache. A runner that isn't installed should never
 * be offered for selection in any surface.
 */
export class RunnerInstallation {
  private cache: Map<string, boolean> = new Map();
  private inflight: Map<string, Promise<boolean>> = new Map();
  private registry: RunnerRegistry;
  private execImpl: ExecImpl;

  constructor(registry: RunnerRegistry, execImpl: ExecImpl = defaultExec) {
    this.registry = registry;
    this.execImpl = execImpl;
  }

  /** True if the runner's CLI responds to `--version`. Cached per process. */
  async isInstalled(runner: string): Promise<boolean> {
    if (this.cache.has(runner)) return this.cache.get(runner)!;

    const existing = this.inflight.get(runner);
    if (existing) return existing;

    const manifest = this.registry.getManifest(runner);
    const command = manifest?.runner.command;
    if (!command) {
      this.cache.set(runner, false);
      return false;
    }

    const probe = (async () => {
      try {
        await this.execImpl(`${command} --version`, { timeout: CHECK_TIMEOUT_MS });
        return true;
      } catch {
        return false;
      }
    })().then((installed) => {
      this.cache.set(runner, installed);
      this.inflight.delete(runner);
      return installed;
    });

    this.inflight.set(runner, probe);
    return probe;
  }

  /**
   * Whether this runner can serve as a harness planner (ADR-0009, T9), and why
   * not when it cannot. Surfaces call this to grey out an unusable agent in the
   * planner picker with the reason attached — discovering a missing CLI after
   * typing a real goal is the failure this exists to prevent.
   *
   * "Usable" is deliberately shallow: the binary answers `--version`, and the
   * runner declares a planner transport. Whether the user's subscription is
   * live cannot be known without spending a turn on it, so an expired login
   * surfaces where it actually bites — as the agent's own error text on the
   * first turn.
   */
  async plannerUsability(runner: string): Promise<{ usable: boolean; reason?: string }> {
    const manifest = this.registry.getManifest(runner);
    if (!manifest) return { usable: false, reason: `No runner manifest is registered for "${runner}".` };
    if (!PLANNER_CAPABLE_RUNNERS.has(runner)) {
      return { usable: false, reason: `${manifest.displayName ?? runner} has no planner transport yet.` };
    }
    if (!(await this.isInstalled(runner))) {
      return { usable: false, reason: `${manifest.runner.command} is not installed or is not on PATH.` };
    }
    const spawnable = await this.isSpawnable(manifest.runner.command);
    if (!spawnable) {
      return {
        usable: false,
        reason: `${manifest.runner.command} answers --version through a shell, but no file Ordewell can start directly was found on PATH. ` +
          `The planner speaks to the agent over stdio with no shell in between, so it needs a real executable or a .cmd/.bat shim. ` +
          `Reinstall with the CLI's own installer, or add its install directory to PATH.`,
      };
    }
    return { usable: true };
  }

  /**
   * Whether the CLI can be started the way the harness planner actually starts
   * it: `spawn` with no shell.
   *
   * `isInstalled` probes through `exec`, which goes through cmd.exe on Windows
   * and so happily resolves a `.cmd` shim — while the planner's own spawn does
   * not, because CreateProcess performs no PATHEXT lookup. That gap produced
   * the worst failure shape available: the picker reported the runner healthy,
   * then the session died on ENOENT with nothing to act on. POSIX has no such
   * split (`execvp` and `exec` search PATH identically), so this always agrees
   * with `isInstalled` there.
   */
  private async isSpawnable(command: string): Promise<boolean> {
    if (process.platform !== 'win32') return true;
    try {
      const plan = await planDirectLaunch(command, []);
      // An unresolvable command is handed back verbatim; anything else means a
      // real file was found, directly or behind the interpreter.
      return plan.file !== command;
    } catch {
      // A CommandLineTooLongError cannot happen with no arguments; anything
      // else here is a resolution failure, which is the answer.
      return false;
    }
  }

  /** Subset of the given runner ids whose CLI is installed. */
  async filterInstalled(runners: string[]): Promise<string[]> {
    const results = await Promise.all(
      runners.map(async (r) => ({ r, ok: await this.isInstalled(r) })),
    );
    return results.filter((x) => x.ok).map((x) => x.r);
  }

  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }
}
