import type { ChildProcess } from 'child_process';
import type { AgentProcessDeps } from './AgentAdapter';
import { killTree, spawnInOwnGroup } from '../../utils/processTree';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { augmentedPath, withPath } from '../../utils/shellPath';

const CODEX_RUNNER = 'codex';

/** A probe that hangs must not hold up session start; an unclear answer means "change nothing". */
const PROBE_TIMEOUT_MS = 10000;

/**
 * The bubblewrap failure this module exists for, as the sandbox itself reports
 * it. Matching the message — rather than treating any non-zero exit as a broken
 * sandbox — keeps an older `codex` without the `sandbox` subcommand, or a probe
 * that fails for some unrelated reason, from being "fixed" by a workaround it
 * does not need.
 */
const USERNS_FAILURE = /bwrap|bubblewrap|user namespace|RTM_NEWADDR/i;

export type CodexSandboxDecision =
  /** Leave Codex alone: its sandbox works, or nothing recognizable is wrong with it. */
  | 'default'
  /** Bubblewrap cannot start; Codex's pre-bubblewrap Landlock backend can. */
  | 'legacy-landlock'
  /** Both backends failed. Codex's own shell can run no command at all. */
  | 'unavailable';

/**
 * Decide which sandbox backend Codex should plan under on this machine.
 *
 * Codex's Linux sandbox is bubblewrap, which needs unprivileged user
 * namespaces. Ubuntu 24.04 restricts those through AppArmor
 * (`kernel.apparmor_restrict_unprivileged_userns=1`) and ships no `bwrap`
 * profile, so every command the planner runs dies with `bwrap: loopback:
 * Failed RTM_NEWADDR: Operation not permitted` — and Codex answers anyway,
 * from memory and web search, which is exactly the confident uninformed plan
 * this repo treats as a silent success (openai/codex#15496, #16334).
 *
 * `use_legacy_landlock` selects the backend Codex used before bubblewrap.
 * Landlock is an LSM, needs no namespace, and still denies the writes that make
 * read-only planning read-only. It is deprecated upstream, which is why it is
 * opted into only on a machine that has been observed to need it, and why its
 * own failure is not special-cased: an unrecognized outcome leaves Codex
 * configured exactly as it configures itself.
 *
 * Asking the binary beats inferring from `/proc` and `/etc/apparmor.d`: it is
 * the same question, put to the thing that will have to answer it, and it costs
 * one ~40ms process.
 */
export async function probeCodexSandbox(
  deps: AgentProcessDeps,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexSandboxDecision> {
  // Bubblewrap is the Linux backend only, so there is nothing here to probe
  // elsewhere: macOS uses Seatbelt, which cannot fail this way. A placed Codex
  // runs on another machine, whichever this one is, and that one is asked.
  //
  // Windows is a weaker statement and deliberately not dressed up as a stronger
  // one. Codex's own sandboxing there is not the OS-enforced equivalent of
  // Seatbelt or Landlock, so `sandbox: 'read-only'` in `CodexAdapter.startThread`
  // may be honoured by Codex's tool layer rather than by the kernel. The
  // approvals side of the invariant still holds by construction
  // (`approvalPolicy: 'on-request'`, where what Codex asks to run or change is
  // declined and every other server→client request gets a definite refusal or
  // an Ordewell decision, ADR-0026), and the planner prompt never asks for a
  // write — but "read-only by
  // construction" (ADR-0009) is a Linux/macOS guarantee, not yet a verified
  // Windows one. Returning 'default' declines to invent a workaround for a
  // failure mode nobody has observed; it does not claim the guarantee is proven.
  if (!deps.placement && (deps.platform ?? process.platform) !== 'linux') return 'default';

  const bubblewrap = await runProbe(deps, cwd, env, []);
  if (bubblewrap.code === 0) return 'default';
  if (!USERNS_FAILURE.test(bubblewrap.output)) return 'default';

  const landlock = await runProbe(deps, cwd, env, ['--enable', 'use_legacy_landlock']);
  return landlock.code === 0 ? 'legacy-landlock' : 'unavailable';
}

const NAMESPACE_CAUSE = "Its Linux sandbox needs unprivileged user namespaces, which this kernel restricts (Ubuntu 24.04's AppArmor default), and the legacy Landlock backend did not work either.";

const SYSCTL_FIX = '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0';

/** The message shown when Codex has no working sandbox and cannot do without one, naming both documented fixes. */
export function codexSandboxUnavailableMessage(role: 'planner' | 'task' | 'container' = 'planner'): string {
  // No sysctl here: what refuses the namespaces is the container's hardening, which no host setting changes and Ordewell does not loosen for a runner.
  if (role === 'container') {
    return [
      "Codex cannot start its sandbox in this task's container, so it can run no command in this task's mode.",
      '',
      'Its sandbox needs namespaces of its own, which a hardened container does not give. There the container is what holds the runner, so give the task Full access or another runner, then run the task again.',
    ].join('\n');
  }
  if (role === 'task') {
    return [
      "Codex cannot start a sandbox on this machine, so it can run no command in this task's mode.",
      '',
      NAMESPACE_CAUSE,
      '',
      'Give the task Full access or another runner, or allow user namespaces:',
      SYSCTL_FIX,
      '',
      'or install an AppArmor profile for bwrap, then run the task again.',
    ].join('\n');
  }
  return [
    'Codex cannot start a sandbox on this machine, so it can run no command and cannot read the workspace.',
    '',
    NAMESPACE_CAUSE,
    '',
    'Either allow them:',
    SYSCTL_FIX,
    '',
    'or install an AppArmor profile for bwrap, then plan with Codex again.',
  ].join('\n');
}

/**
 * Shown once when a planner starts with Codex's own shell switched off
 * because no sandbox backend works (ADR-0033): planning goes on, and the note
 * says what is missing and how to get it back.
 */
export function codexShellOffNote(): string {
  return [
    "Codex cannot start its sandbox on this machine, so its own shell is off for planning. It reads the workspace through Ordewell's run_command, under the same command rules as every other planner.",
    '',
    `${NAMESPACE_CAUSE} To give Codex its own shell back:`,
    SYSCTL_FIX,
    '',
    'or install an AppArmor profile for bwrap, then start a new planning session.',
  ].join('\n');
}

export const CODEX_SANDBOX_DOCS = 'https://github.com/ordewell/ordewell/blob/main/docs/troubleshooting.md#codex-sandbox-unavailable-on-this-host';

/** The one line a surface shows next to the runner list while Codex's sandboxed modes are off. */
export const CODEX_SANDBOX_OFF_LINE = 'Codex sandbox unavailable on this host: Guarded mode is off';

/**
 * Why each sandboxed Codex mode is off. It is a whole sentence with both ways
 * out, because the planner's refusal, a hand edit's refusal and a task's
 * failure at spawn all show it as it is.
 */
export const CODEX_SANDBOX_MODE_REASON =
  `Codex's sandbox cannot start on this host (its kernel restricts unprivileged user namespaces), so Codex's Guarded mode is off. Use Full access or another runner, or fix the host: ${CODEX_SANDBOX_DOCS}`;

/**
 * The line a runner or mode list shows, and the page that explains it, when
 * the catalog says Codex's sandboxed modes are off. Null when nothing is.
 * Surfaces read the catalog, not the probe, so a daemon they reach over HTTP
 * and an in-process one answer alike.
 */
export function codexSandboxNotice(
  modesByRunner: Partial<Record<string, ReadonlyArray<{ unavailable?: string }>>> | undefined,
): { line: string; docs: string } | null {
  if (!modesByRunner?.[CODEX_RUNNER]?.some((m) => m.unavailable)) return null;
  return { line: CODEX_SANDBOX_OFF_LINE, docs: CODEX_SANDBOX_DOCS };
}

/**
 * What Ordewell knows about Codex's sandbox on this host, applied to the
 * runner catalog so the planner, the surfaces and the spawn all read the same
 * answer (ADR-0033).
 *
 * The probe runs once per daemon and its answer is kept; {@link refresh}
 * asks again, for when the runner list is refreshed, so a host fixed while the
 * daemon runs is noticed without a restart. Concurrent callers share one probe.
 */
export class CodexSandboxAvailability {
  private pending: Promise<void> | null = null;
  private known = false;

  constructor(
    private readonly registry: RunnerRegistry,
    private readonly deps: AgentProcessDeps,
    private readonly host: { cwd: string; env: NodeJS.ProcessEnv },
  ) {}

  /** The cached answer; probes only the first time. */
  ensure(): Promise<void> {
    if (this.known) return Promise.resolve();
    return this.refresh();
  }

  /** Probe again and update the catalog with the answer. */
  refresh(): Promise<void> {
    this.pending ??= this.probe().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async decide(): Promise<CodexSandboxDecision> {
    try {
      // The PATH a runner is started under, so a `codex` a GUI-launched host
      // cannot see is not mistaken for one with a working sandbox.
      const env = withPath(this.host.env, await (this.deps.resolvePath ?? augmentedPath)());
      return await probeCodexSandbox(this.deps, this.host.cwd, env);
    } catch {
      return 'default';
    }
  }

  private async probe(): Promise<void> {
    const manifest = this.registry.getManifest(CODEX_RUNNER);
    if (!manifest) return;
    // A probe that cannot be run says nothing, so it clears the marks rather than guessing.
    const decision = await this.decide();
    const sandboxed = (manifest.modes ?? []).filter((m) => m.sandboxed);
    this.registry.setUnavailableModes(
      CODEX_RUNNER,
      decision === 'unavailable' ? Object.fromEntries(sandboxed.map((m) => [m.id, CODEX_SANDBOX_MODE_REASON])) : {},
    );
    this.known = true;
  }
}

async function runProbe(
  deps: AgentProcessDeps,
  cwd: string,
  env: NodeJS.ProcessEnv,
  flags: string[],
): Promise<{ code: number | null; output: string }> {
  const args = ['sandbox', ...flags, '--', '/bin/true'];
  const placed = await deps.placement?.place({ command: 'codex', args, env: {}, files: [] });
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let proc: ChildProcess | null = null;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      placed?.ended();
      resolve({ code, output });
    };

    const timer = setTimeout(() => {
      placed?.stop();
      finish(null);
      // The answer is refused, so the probe has no owner left; nothing knows
      // its pid, and leaving it running would hold the workspace for the
      // host's lifetime. Its own process group, like every runner.
      killTree(proc, { platform: deps.platform });
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    try {
      proc = spawnInOwnGroup((detached) => deps.spawn(placed?.command ?? 'codex', placed?.args ?? args, {
        env: { ...env, ...placed?.env }, stdio: ['pipe', 'pipe', 'pipe'], cwd, detached,
      }), deps.platform);
    } catch {
      finish(null);
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('error', () => finish(null));
    // 'close', not 'exit': the answer is what the probe printed, and Node can
    // fire 'exit' before the pipe has drained.
    proc.on('close', (code) => finish(code));
  });
}
