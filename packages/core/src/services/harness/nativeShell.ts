import { compareVersions } from '../../utils/version';

/**
 * Whether a harness planner may be offered its own shell (ADR-0036 N2, N4), and
 * why not when it cannot. The table below is the live checks and nothing more:
 * a harness or version it does not name has not been checked, so it keeps
 * `run_command` alone. A new harness release is not handed an older release's
 * checks; it waits for its own.
 */
export type NativeShellOffer =
  | { offered: true }
  /** A whole sentence, shown once per session and in the setting's description. */
  | { offered: false; reason: string };

interface CheckedRange {
  /** The version the checks ran on; earlier versions were not checked. */
  since: string;
  /** The first version after the checked line; nothing at or above it was checked. */
  before: string;
  /** Where the checks ran. A platform not named here was not checked. */
  platforms: readonly NodeJS.Platform[];
}

/** Checked live on 2026-10-21 on macOS 26, through Ordewell's sandbox around the harness's shell (ADR-0036, Live checks). */
const CHECKED: Readonly<Record<string, CheckedRange>> = {
  'claude-code': { since: '2.1.304', before: '2.2.0', platforms: ['darwin'] },
  opencode: { since: '2.0.32', before: '2.1.0', platforms: ['darwin'] },
};

const LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
};

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

/**
 * What to tell the user about the opt-in for this harness. `version` is the
 * one the harness reported: Claude Code's `init` line, or an OpenCode 2.x
 * server's `/api/info`. Null means it reported none — Claude Code before its
 * first `init`, or OpenCode 1.x, which does not answer with one.
 *
 * Linux is deliberately not offered yet: N2 asks for checks on the installed
 * version, the checks were run on macOS, and bubblewrap passing is a sandbox
 * probe rather than a live check of either harness's shell.
 */
export function nativeShellOffer(input: {
  runner: string;
  version: string | null;
  platform?: NodeJS.Platform;
}): NativeShellOffer {
  const platform = input.platform ?? process.platform;
  const label = LABELS[input.runner] ?? input.runner;
  if (input.runner === 'codex') {
    return {
      offered: false,
      reason: platform === 'win32'
        ? "On Windows Codex plans with its own shell off, since its sandbox there cannot keep a command off the network, and runs every command through Ordewell's (ADR-0010)."
        : 'Codex already runs its own shell, read-only and without the network (ADR-0026), so this setting changes nothing for it.',
    };
  }
  const checked = CHECKED[input.runner];
  if (!checked) {
    return { offered: false, reason: `${label} has not been checked live, so its own shell is not offered.` };
  }
  if (!checked.platforms.includes(platform)) {
    const checkedOn = checked.platforms.map((one) => PLATFORM_LABELS[one] ?? one).join(', ');
    return {
      offered: false,
      reason: `The opt-in was checked on ${checkedOn} only, and not on ${PLATFORM_LABELS[platform] ?? platform}.`,
    };
  }
  if (input.version === null) {
    if (input.runner === 'opencode') {
      return {
        offered: false,
        reason: `OpenCode 1.x does not report a version and was not checked; the opt-in was checked on OpenCode ${checked.since}.`,
      };
    }
    return { offered: false, reason: `${label} has not reported its version, so it has not been checked.` };
  }
  if (compareVersions(input.version, checked.since) < 0 || compareVersions(input.version, checked.before) >= 0) {
    return {
      offered: false,
      reason: `${label} ${input.version} has not been checked; the opt-in was checked on ${label} ${checked.since}.`,
    };
  }
  return { offered: true };
}
