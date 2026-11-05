import { exec } from 'child_process';
import { promisify } from 'util';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerManifest } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';
import { planDirectLaunch } from '../utils/launch';
import type { ExecImpl } from './ModelDiscovery';
import { connectorFor } from './harness/connectors';
import { readRunnerAuth, recordRunnerAuth, type RunnerAuth, type RunnerAuthExec } from './runnerAuth';

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
 * How long a "not installed" verdict is trusted before the next probe re-runs
 * it. A missing CLI is the verdict that goes stale while a host runs — the user
 * installs it and expects the next look to see it — whereas an installed one
 * does not: a CLI that disappears fails its spawn with the real error, which
 * this shallow probe is not trying to predict. A refresh asks again at once;
 * this bounds the wait when nothing calls one.
 */
const NEGATIVE_TTL_MS = 60_000;

/**
 * How long a login verdict is trusted. Short on purpose: the user can log in
 * or out while a host runs, and a refresh asks again at once.
 */
const AUTH_TTL_MS = 30_000;

export interface RunnerInstallationOptions {
  /**
   * The workspace's own variables (ADR-0016), asked afresh for each auth probe
   * and told which root it is for, so a folder change mid-probe cannot mix one
   * workspace's account into another's verdict. A `.envrc` can choose another
   * account, so the probe must ask the same account the planner will use.
   */
  env?: (workspace?: string) => Promise<Record<string, string>>;
  /**
   * The workspace whose account this installation judges. The verdict is
   * recorded under it, so a planner gate in that workspace reads it and one in
   * another cannot (ADR-0009).
   */
  workspace?: () => string | undefined;
  /** Injectable status command runner, so tests need no real agent binary. */
  authExec?: RunnerAuthExec;
}

/**
 * Detects whether a runner's underlying CLI is actually installed on the host,
 * by invoking `<command> --version`. Mirrors ModelDiscovery: injectable exec,
 * augmented PATH, per-process cache. A runner that isn't installed should never
 * be offered for selection in any surface.
 */
/**
 * The version a CLI printed for `--version`: its first dotted number, so
 * "claude 1.4.2 (Claude Code)" and "codex-cli 0.9.1" both read as the number.
 * Undefined when there is none, and a surface then shows no version at all.
 */
export function parseCliVersion(stdout: string): string | undefined {
  return /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(stdout)?.[1];
}

export class RunnerInstallation {
  private cache: Map<string, { installed: boolean; at: number; version?: string }> = new Map();
  private inflight: Map<string, Promise<boolean>> = new Map();
  private authCache: Map<string, { auth: RunnerAuth; at: number }> = new Map();
  private authInflight: Map<string, Promise<RunnerAuth>> = new Map();
  private registry: RunnerRegistry;
  private execImpl: ExecImpl;
  private now: () => number;
  private env: (workspace?: string) => Promise<Record<string, string>>;
  private workspace: () => string | undefined;
  private authExec: RunnerAuthExec | undefined;

  constructor(
    registry: RunnerRegistry,
    execImpl: ExecImpl = defaultExec,
    now: () => number = Date.now,
    options: RunnerInstallationOptions = {},
  ) {
    this.registry = registry;
    this.execImpl = execImpl;
    this.now = now;
    this.env = options.env ?? (async () => ({}));
    this.workspace = options.workspace ?? (() => undefined);
    this.authExec = options.authExec;
  }

  /** True if the runner's CLI responds to `--version`. Cached per process. */
  async isInstalled(runner: string): Promise<boolean> {
    const cached = this.cache.get(runner);
    if (cached && (cached.installed || this.now() - cached.at < NEGATIVE_TTL_MS)) return cached.installed;

    const existing = this.inflight.get(runner);
    if (existing) return existing;

    const manifest = this.registry.getManifest(runner);
    const command = manifest?.runner.command;
    if (!command) {
      this.cache.set(runner, { installed: false, at: this.now() });
      return false;
    }

    const probe = (async () => {
      try {
        const { stdout } = await this.execImpl(`${command} --version`, { timeout: CHECK_TIMEOUT_MS });
        return { installed: true, version: parseCliVersion(String(stdout ?? '')) };
      } catch {
        return { installed: false, version: undefined };
      }
    })().then(({ installed, version }) => {
      this.cache.set(runner, { installed, at: this.now(), ...(version ? { version } : {}) });
      this.inflight.delete(runner);
      return installed;
    });

    this.inflight.set(runner, probe);
    return probe;
  }

  /**
   * Forget cached "not installed" verdicts so the next probe re-runs them. A
   * runner-list refresh calls this, so a CLI installed while the host runs is
   * offered without a restart. An installed verdict stays: it cannot have
   * changed without the binary going away, and re-probing one costs a spawn.
   */
  refresh(): void {
    for (const [runner, probe] of this.cache) if (!probe.installed) this.cache.delete(runner);
    // A login can change in either direction while a host runs, and a refresh
    // is the moment the user expects a fixed one to show.
    this.authCache.clear();
  }

  /**
   * Whether this runner can serve as a harness planner (ADR-0009, T9), and why
   * not when it cannot. Surfaces call this to grey out an unusable agent in the
   * planner picker with the reason attached — discovering a missing CLI after
   * typing a real goal is the failure this exists to prevent.
   *
   * "Usable" is deliberately shallow: the binary answers `--version`, and the
   * runner has a connector to plan over. A signed-out runner stays usable —
   * it is installed, and the user may log in from the same picker — so the
   * auth verdict rides beside usability, never inside it.
   */
  async plannerUsability(runner: string): Promise<{ usable: boolean; reason?: string; auth?: RunnerAuth; version?: string }> {
    const manifest = this.registry.getManifest(runner);
    if (!manifest) return { usable: false, reason: `No runner manifest is registered for "${runner}".` };
    if (!connectorFor(runner)) {
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
    const version = this.cache.get(runner)?.version;
    return { usable: true, auth: await this.authFor(runner, manifest), ...(version ? { version } : {}) };
  }

  /**
   * The runner's own login verdict, cached briefly and asked once when several
   * callers arrive together. Recorded per workspace for the synchronous planner
   * gate, which cannot await this.
   */
  private async authFor(runner: string, manifest: RunnerManifest): Promise<RunnerAuth> {
    // Capture the scope once: the folder can move while the status command
    // runs, and the verdict belongs to the workspace whose env produced it.
    const workspace = this.workspace();
    const key = `${workspace ?? ''}\u0000${runner}`;
    const cached = this.authCache.get(key);
    if (cached && this.now() - cached.at < AUTH_TTL_MS) return cached.auth;

    const existing = this.authInflight.get(key);
    if (existing) return existing;

    const probe = (async () => {
      try {
        return await readRunnerAuth(manifest, {
          ...(this.authExec ? { exec: this.authExec } : {}),
          env: await this.env(workspace),
        });
      } catch {
        // A workspace env or status probe that fails is no answer about the
        // login, and must not flag a planner the runner might accept.
        return { state: 'unknown' as const };
      }
    })().then((auth) => {
      this.authCache.set(key, { auth, at: this.now() });
      this.authInflight.delete(key);
      recordRunnerAuth(runner, auth, workspace);
      return auth;
    });

    this.authInflight.set(key, probe);
    return probe;
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
