import type { AgentProcessDeps } from './AgentAdapter';

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
  /** Both backends failed. Codex can run no command at all, so it cannot explore. */
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
  // elsewhere: macOS uses Seatbelt, which cannot fail this way.
  //
  // Windows is a weaker statement and deliberately not dressed up as a stronger
  // one. Codex's own sandboxing there is not the OS-enforced equivalent of
  // Seatbelt or Landlock, so `sandbox: 'read-only'` in `CodexAdapter.startThread`
  // may be honoured by Codex's tool layer rather than by the kernel. The
  // approvals side of the invariant still holds by construction
  // (`approvalPolicy: 'never'`, and the whole server→client request surface is
  // refused), and the planner prompt never asks for a write — but "read-only by
  // construction" (ADR-0009) is a Linux/macOS guarantee, not yet a verified
  // Windows one. Returning 'default' declines to invent a workaround for a
  // failure mode nobody has observed; it does not claim the guarantee is proven.
  if ((deps.platform ?? process.platform) !== 'linux') return 'default';

  const bubblewrap = await runProbe(deps, cwd, env, []);
  if (bubblewrap.code === 0) return 'default';
  if (!USERNS_FAILURE.test(bubblewrap.output)) return 'default';

  const landlock = await runProbe(deps, cwd, env, ['--enable', 'use_legacy_landlock']);
  return landlock.code === 0 ? 'legacy-landlock' : 'unavailable';
}

/** The message shown when Codex has no working sandbox, naming both documented fixes. */
export function codexSandboxUnavailableMessage(): string {
  return [
    'Codex cannot start a sandbox on this machine, so it can run no command and cannot read the workspace.',
    '',
    "Its Linux sandbox needs unprivileged user namespaces, which this kernel restricts (Ubuntu 24.04's AppArmor default), and the legacy Landlock backend did not work either.",
    '',
    'Either allow them:',
    '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    '',
    'or install an AppArmor profile for bwrap, then plan with Codex again.',
  ].join('\n');
}

function runProbe(
  deps: AgentProcessDeps,
  cwd: string,
  env: NodeJS.ProcessEnv,
  flags: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };

    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    timer.unref?.();

    let proc;
    try {
      proc = deps.spawn('codex', ['sandbox', ...flags, '--', '/bin/true'], {
        env, stdio: ['pipe', 'pipe', 'pipe'], cwd,
      });
    } catch {
      finish(null);
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    proc.on('error', () => finish(null));
    proc.on('exit', (code) => finish(code));
  });
}
