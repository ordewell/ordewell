import { exec } from 'child_process';
import { promisify } from 'util';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { inProcessProvider, runnerCommand, type RunnerManifest } from '../plugins/types';
import type { AiProvider } from '../interfaces/IConfig';
import { augmentedPath, clearAugmentedPathCache, withPath } from '../utils/shellPath';
import { isExecutableResolved, planDirectLaunch, type LaunchDeps } from '../utils/launch';
import { compareVersions } from '../utils/version';
import type { ExecImpl } from './ModelDiscovery';
import { connectorFor } from './harness/connectors';
import { forgetRunnerAuth, readRunnerAuth, recordedRunnerAuth, recordRunnerAuth, runnerAuthClock, type RunnerAuth, type RunnerAuthExec } from './runnerAuth';
import { VENDORS, vendorConfiguredIn } from './apiProviders';
import { withHostCredentials } from './hostCredentials';

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
  /** How the CLI is located and started, for the spawnability check and the status command alike; a test pins the host's. */
  launch?: LaunchDeps;
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
/** Whether an agent can be started, why not, and its login verdict beside it. */
export interface RunnerUsability { usable: boolean; reason?: string; auth?: RunnerAuth; version?: string }

/** Why an in-process runner cannot start: what configures its provider is unset. */
function unconfiguredReason(manifest: RunnerManifest): string {
  const provider = inProcessProvider(manifest);
  if (provider === 'openai_compatible') return `No ${manifest.displayName} endpoint is set: set ${VENDORS.openai_compatible.baseUrlEnvVar}.`;
  return `No ${manifest.displayName} key is set: add one with /key-set.`;
}

/**
 * The recorded verdict, with the ways in the probe read from the manifest when
 * the record carries none: a session discovery saw open says signed in and
 * nothing else, and a row must still offer its login (ADR-0052).
 */
function withWaysIn(recorded: RunnerAuth | undefined, probed: RunnerAuth): RunnerAuth {
  if (!recorded) return probed;
  if (recorded.signIn || !probed.signIn) return recorded;
  return { ...recorded, signIn: probed.signIn, ...(probed.loginCommand ? { loginCommand: probed.loginCommand } : {}) };
}

export class RunnerInstallation {
  private cache: Map<string, { installed: boolean; at: number; version?: string }> = new Map();
  private inflight: Map<string, Promise<boolean>> = new Map();
  private authCache: Map<string, { auth: RunnerAuth; at: number }> = new Map();
  private authInflight: Map<string, Promise<RunnerAuth>> = new Map();
  /** When {@link recheck} last asked about each workspace's runner, so a probe begun before it is not cached after it. */
  private rechecked: Map<string, number> = new Map();
  private registry: RunnerRegistry;
  private execImpl: ExecImpl;
  private now: () => number;
  private env: (workspace?: string) => Promise<Record<string, string>>;
  private workspace: () => string | undefined;
  private authExec: RunnerAuthExec | undefined;
  private launch: LaunchDeps;

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
    this.launch = options.launch ?? {};
  }

  /**
   * True if the runner's CLI responds to `--version`, cached per process; for
   * an in-process runner, whether its provider is configured.
   */
  async isInstalled(runner: string): Promise<boolean> {
    const manifest = this.registry.getManifest(runner);
    // An in-process runner is code Ordewell ships: there is no binary to ask,
    // and it is installed exactly where its provider is configured (ADR-0070),
    // so a provider with no key has no runner to list, sign in or pick. Asked
    // afresh each time, never cached, since `/key-set` sets a key into this
    // very process and the next look must see it.
    const provider = manifest && inProcessProvider(manifest);
    if (provider) return this.providerConfigured(provider);

    const cached = this.cache.get(runner);
    if (cached && (cached.installed || this.now() - cached.at < NEGATIVE_TTL_MS)) return cached.installed;

    const existing = this.inflight.get(runner);
    if (existing) return existing;

    const command = manifest && runnerCommand(manifest);
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
   * Forget every cached install verdict so the next probe re-runs it. A
   * runner-list refresh calls this, so a CLI installed, upgraded or removed
   * while the host runs is offered, or refused, without a restart: the
   * version decides whether an ACP agent is new enough, so a present binary
   * can go stale too, and so can the PATH the probes search.
   */
  refresh(): void {
    this.cache.clear();
    // The login shell's PATH is part of every verdict: an installer that adds
    // a directory to the profile is only seen once the shell is asked again.
    clearAugmentedPathCache();
    // A login can change in either direction while a host runs, and a refresh
    // is the moment the user expects a fixed one to show. Only the probes are
    // forgotten: a turn's or discovery's refusal stays recorded, since a
    // status-less agent's probe answers nothing that could replace it, and a
    // runner with a status command answers for itself (ADR-0052).
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
  async plannerUsability(runner: string): Promise<RunnerUsability> {
    const manifest = this.registry.getManifest(runner);
    if (!manifest) return { usable: false, reason: `No runner manifest is registered for "${runner}".` };
    const connector = connectorFor(runner);
    if (!connector) {
      return { usable: false, reason: `${manifest.displayName ?? runner} has no planner transport yet.` };
    }
    if (!connector.plans) {
      // A planner under a provider runner's id is the API planner on that provider, never the runner (ADR-0009).
      if (inProcessProvider(manifest)) return { usable: false, reason: `The built-in runner does not plan: plan with the ${manifest.displayName} API planner instead.` };
      return { usable: false, reason: `${manifest.displayName ?? runner} can run tasks but cannot plan in Ordewell yet.` };
    }
    return this.runnerUsability(runner);
  }

  /**
   * {@link plannerUsability} without the question of planning: whether the
   * agent's CLI is installed and can be started, with its login verdict. The
   * runner list and the login flows ask this, because a task runner that cannot
   * plan yet (an ACP agent) is still offered and still needs signing in.
   */
  async runnerUsability(runner: string): Promise<RunnerUsability> {
    const manifest = this.registry.getManifest(runner);
    if (!manifest) return { usable: false, reason: `No runner manifest is registered for "${runner}".` };
    const command = runnerCommand(manifest);
    if (command === undefined) {
      if (!(await this.isInstalled(runner))) return { usable: false, reason: unconfiguredReason(manifest) };
      return { usable: true, auth: this.inProcessAuth(runner) };
    }
    if (!(await this.isInstalled(runner))) {
      return { usable: false, reason: `${command} is not installed or is not on PATH.` };
    }
    const version = this.cache.get(runner)?.version;
    // An ACP agent below the version its profile was checked against fails at
    // initialize, after a planner was picked and a goal typed. Comparing the
    // CLI's own version here lists it with the reason instead (ADR-0060).
    const minVersion = connectorFor(runner)?.minVersion;
    if (minVersion && version && compareVersions(version, minVersion) < 0) {
      return {
        usable: false,
        reason: `${manifest.displayName ?? manifest.name} is too old for Ordewell: found ${version}, needs ${minVersion} or later.`,
      };
    }
    const spawnable = await this.isSpawnable(command);
    if (!spawnable) {
      return {
        usable: false,
        reason: `${command} answers --version through a shell, but no file Ordewell can start directly was found on PATH. ` +
          `The planner speaks to the agent over stdio with no shell in between, so it needs a real executable or a .cmd/.bat shim. ` +
          `Reinstall with the CLI's own installer, or add its install directory to PATH.`,
      };
    }
    return { usable: true, auth: await this.authFor(runner, manifest), ...(version ? { version } : {}) };
  }

  /**
   * The runner's login verdict, cached briefly and asked once when several
   * callers arrive together. Recorded per workspace for the synchronous planner
   * gate, which cannot await this, and answered from that record: a turn's or
   * discovery's refusal outranks a status command that cannot say (ADR-0052),
   * so a refresh or the TTL asks again without erasing it.
   */
  private async authFor(runner: string, manifest: RunnerManifest): Promise<RunnerAuth> {
    // Capture the scope once: the folder can move while the status command
    // runs, and the verdict belongs to the workspace whose env produced it.
    const workspace = this.workspace();
    const key = `${workspace ?? ''}\u0000${runner}`;
    const cached = this.authCache.get(key);
    if (cached && this.now() - cached.at < AUTH_TTL_MS) return withWaysIn(recordedRunnerAuth(runner, workspace), cached.auth);

    const existing = this.authInflight.get(key);
    if (existing) return existing;

    const asOf = runnerAuthClock();
    const probe = (async () => {
      try {
        return await readRunnerAuth(manifest, {
          ...(this.authExec ? { exec: this.authExec } : {}),
          env: await this.env(workspace),
          launch: this.launch,
        });
      } catch {
        // A workspace env or status probe that fails is no answer about the
        // login, and must not flag a planner the runner might accept.
        return { state: 'unknown' as const };
      }
    })().then((auth) => {
      this.authInflight.delete(key);
      recordRunnerAuth(runner, auth, workspace, { source: 'status', asOf });
      // An answer asked before a recheck or login is no answer about now.
      if (!this.clearedSince(key, asOf)) this.authCache.set(key, { auth, at: this.now() });
      return withWaysIn(recordedRunnerAuth(runner, workspace), auth);
    });

    this.authInflight.set(key, probe);
    return probe;
  }

  private clearedSince(key: string, asOf: number): boolean {
    return (this.rechecked.get(key) ?? 0) > asOf;
  }

  /**
   * Ask about one runner's sign-in again because its user asked: a login that
   * finished, or an explicit recheck (ADR-0052). Unlike {@link refresh}, the
   * runner-list refresh every surface calls on its own, this forgets what a
   * turn or discovery recorded for this workspace, so the agent reads as its
   * status command now answers, or `unknown` (not checked) where it has none:
   * a terminal's exit alone never reads as signed in. The next refusal records
   * the blocker again.
   */
  async recheck(runner: string): Promise<RunnerUsability> {
    const workspace = this.workspace();
    const key = `${workspace ?? ''}\u0000${runner}`;
    forgetRunnerAuth(runner, workspace);
    this.rechecked.set(key, runnerAuthClock());
    this.authCache.delete(key);
    this.authInflight.delete(key);
    return this.runnerUsability(runner);
  }

  /**
   * Whether the provider is configured in the host's environment under the
   * workspace's, with what the host holds for the runner over both, as a
   * start would read it.
   */
  private async providerConfigured(provider: AiProvider): Promise<boolean> {
    let env: Record<string, string | undefined>;
    try {
      env = { ...process.env, ...(await this.env(this.workspace())) };
    } catch {
      env = { ...process.env };
    }
    return vendorConfiguredIn(withHostCredentials(env), provider);
  }

  /**
   * An in-process runner is signed in whenever it is listed: its sign-in is
   * its provider's key, which is also what makes it installed (ADR-0070), so
   * it never reads as signed out and offers no Log in (ADR-0052).
   */
  private inProcessAuth(runner: string): RunnerAuth {
    const auth: RunnerAuth = { state: 'signed-in' };
    recordRunnerAuth(runner, auth, this.workspace());
    return auth;
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
    if ((this.launch.platform ?? process.platform) !== 'win32') return true;
    try {
      const plan = await planDirectLaunch(command, [], this.launch);
      // Asked as the runner's own start asks it (runnerProcess), so the two
      // cannot disagree. Windows judges by the plan, which searched PATH itself.
      return isExecutableResolved(command, plan, '', this.launch);
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
