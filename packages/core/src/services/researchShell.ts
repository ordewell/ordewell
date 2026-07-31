import * as fsSync from 'fs';
import * as path from 'path';

/**
 * Which interpreter runs the planner's `bash` tool, and in which language.
 *
 * `AUTO_COMMANDS` — the read-only tier that runs with no prompt — is `ls`, `cat`,
 * `wc`, `head`, `tail`, `du`, `df`, `file`, `sort`, `uniq`, `basename`, `find`,
 * `grep`. That set is POSIX, and passing it to `shell: true` on Windows means
 * cmd.exe, where most of those names do not exist and `find` is an unrelated
 * program that returns plausible wrong output instead of an error. The planner's
 * whole research surface degraded to guessing, quietly.
 *
 * Rather than write a Windows dialect of every research command — a second
 * behavior to keep in step forever — this finds a POSIX shell to run the
 * existing ones in. Git for Windows ships a full one, and git is already a
 * prerequisite for everything Ordewell does, so in practice it is there. Failing
 * that, cmd.exe is used and the classifier is told so, because the one thing
 * that must never happen is classifying a command in one language and running it
 * in another: `commandPolicy` reads {@link ResearchShell.dialect} for exactly
 * that reason.
 *
 * POSIX resolves to `{ file: null }`, meaning "use `shell: true`" — byte for
 * byte what the adapters did before this module existed.
 *
 * Windows paths are built with `path.win32` explicitly, not the host-flavoured
 * `path`, so the probe is the same on a Windows host as it is under a Linux
 * test runner.
 */

export type ShellDialect = 'posix' | 'cmd';

export interface ResearchShell {
  /**
   * Executable that takes a command string, or null to use the host default
   * via `shell: true`.
   */
  file: string | null;
  /** Arguments preceding the command string. */
  args: string[];
  /** The language the command string will be interpreted in. */
  dialect: ShellDialect;
  /**
   * Directory holding this shell's POSIX utilities, when it brings its own.
   * Prepended to PATH for the search subprocesses (`grep`, `tree`) that
   * `execFile` starts without a shell, so they resolve too.
   */
  utilsDir: string | null;
}

const POSIX_SHELL: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };
const CMD_SHELL: ResearchShell = { file: null, args: [], dialect: 'cmd', utilsDir: null };

export interface ResearchShellDeps {
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

function defaultExists(candidate: string): boolean {
  try {
    return fsSync.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Where Git for Windows puts its shell, per install flavour. `bin/bash.exe` is
 * the wrapper users get on PATH; `usr/bin/bash.exe` is the same shell in the
 * MSYS tree, listed because a minimal/portable install may omit the former.
 *
 * `C:\Windows\System32\bash.exe` is deliberately absent and must stay absent:
 * that is the WSL launcher. It runs commands inside a Linux VM with its own
 * filesystem view (`/mnt/c/...`), so a workspace path means something different
 * there — which would put every command outside the root that path confinement
 * is checking against, and every relative path against the wrong tree.
 */
function gitBashRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && path.win32.join(env['ProgramFiles(x86)'], 'Git'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'),
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git',
  ].filter((r): r is string => !!r);
  return [...new Set(roots)];
}

let cached: ResearchShell | null = null;

/**
 * The shell the planner's `bash` tool should use on this host. Resolved once per
 * process — the answer cannot change while Ordewell runs, and the probe costs a
 * handful of `stat` calls.
 */
export function resolveResearchShell(deps: ResearchShellDeps = {}): ResearchShell {
  if (cached && !deps.platform && !deps.exists && !deps.env) return cached;

  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') {
    if (!deps.platform && !deps.exists && !deps.env) cached = POSIX_SHELL;
    return POSIX_SHELL;
  }

  const exists = deps.exists ?? defaultExists;
  const env = deps.env ?? process.env;

  for (const root of gitBashRoots(env)) {
    for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
      const file = path.win32.join(root, ...rel);
      if (!exists(file)) continue;
      const utilsDir = path.win32.join(root, 'usr', 'bin');
      const resolved: ResearchShell = {
        file,
        // `-c`, not `-lc`: a login shell sources the user's profile, which can
        // change directory out from under a command whose cwd is the workspace.
        args: ['-c'],
        dialect: 'posix',
        utilsDir: exists(path.win32.join(utilsDir, 'grep.exe')) ? utilsDir : null,
      };
      if (!deps.platform && !deps.exists && !deps.env) cached = resolved;
      return resolved;
    }
  }

  if (!deps.platform && !deps.exists && !deps.env) cached = CMD_SHELL;
  return CMD_SHELL;
}

/** Test seam: drop the per-process cache so the next call re-probes. */
export function clearResearchShellCache(): void {
  cached = null;
}

/**
 * PATH for the search subprocesses the adapters start without a shell, with the
 * research shell's own utilities in front. Without this, `grep` — the fallback
 * when ripgrep is absent — is unresolvable on a Windows box even when a
 * perfectly good `grep.exe` sits in the Git tree beside the shell.
 */
export function researchToolsPath(shell: ResearchShell, basePath: string | undefined): string {
  // `utilsDir` is only ever set on the Windows branch, so the delimiter is `;`.
  if (!shell.utilsDir) return basePath ?? '';
  const segments = [shell.utilsDir, ...(basePath ?? '').split(path.win32.delimiter)].filter(Boolean);
  return [...new Set(segments)].join(path.win32.delimiter);
}

/**
 * A message explaining a degraded research surface, or null when there is
 * nothing to explain. Surfaced by the adapters on the first refused command so
 * the limitation is visible rather than inferred from bad answers.
 */
export function researchShellWarning(shell: ResearchShell): string | null {
  if (shell.dialect !== 'cmd') return null;
  return 'No POSIX shell was found on this machine, so research commands run through cmd.exe, '
    + 'where most read-only tools (ls, cat, wc, head, grep, find) do not exist. '
    + 'Installing Git for Windows provides one and restores the full research toolset.';
}
