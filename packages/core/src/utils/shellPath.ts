import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * GUI-launched processes (the VS Code extension host, a desktop-spawned web
 * server) often inherit a minimal PATH that misses user-level install dirs
 * (~/.local/bin, ~/.opencode/bin, nvm shims, …), so spawning `claude` or
 * `opencode` fails even though the user has them installed. This module
 * resolves an augmented PATH once per process: the interactive login shell's
 * PATH (which runs the user's profile, covering nvm/volta/asdf and friends)
 * merged over the current PATH, plus the well-known per-user bin dirs as a
 * final safety net when the login shell itself can't be queried. On Windows
 * there is no login shell to query, so the well-known dirs are the whole net —
 * see {@link windowsBinDirs}.
 *
 * {@link withPath} is the other half: handing the resolved PATH to a child
 * without accidentally giving it two.
 */

const LOGIN_SHELL_TIMEOUT_MS = 5000;
const PATH_MARKER = '__ORDEWELL_PATH__';

type ExecFn = (command: string, options?: { timeout?: number }) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = async (command, options) => {
  const { stdout } = await execAsync(command, options);
  return { stdout: String(stdout) };
};

function posixBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.claude', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
}

/**
 * The Windows counterpart of {@link posixBinDirs}. There is no login shell to
 * ask on Windows, so this list is the only safety net when a runner was
 * installed after the host process started (the registry PATH a GUI-launched
 * VS Code inherited is a snapshot from launch time) or by an installer that
 * writes its own directory rather than amending PATH.
 *
 * The three built-in runners can each arrive by several routes, and the list
 * has to cover all of them or the picker greys out a CLI the user just
 * installed:
 *
 *  - **PowerShell one-liner installers.** `irm https://claude.ai/install.ps1 |
 *    iex` writes a native `claude.exe` to `%USERPROFILE%\.local\bin`, and
 *    OpenCode's writes to `%USERPROFILE%\.opencode\bin`. `.local\bin` was the
 *    conspicuous omission — it is in {@link posixBinDirs}, where the same
 *    installer puts the same binary, and its absence here meant the officially
 *    documented Windows install of the flagship runner was the one Ordewell
 *    could not find.
 *  - **Node package managers.** npm's global prefix, and pnpm's and Yarn's,
 *    which are not under it.
 *  - **Windows package managers.** Scoop and Chocolatey shim directories, and
 *    WinGet's `Links` folder for portable packages (distinct from
 *    `WindowsApps`, which is MSIX only).
 *  - **Version managers.** Volta spells its home `%LOCALAPPDATA%\Volta` here,
 *    not `~/.volta` as it does on POSIX.
 */
function windowsBinDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const join = (...parts: string[]) => path.win32.join(...parts);
  const under = (base: string | undefined, ...parts: string[]) => (base ? [join(base, ...parts)] : []);
  const appData = env.APPDATA;
  const localAppData = env.LOCALAPPDATA;
  const programData = env.ProgramData;

  return [
    // Native per-user installers, PowerShell-driven and otherwise.
    join(home, '.local', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.claude', 'bin'),
    join(home, '.codex', 'bin'),
    ...under(localAppData, 'Programs', 'claude'),

    // Node package managers. npm's global prefix is `%APPDATA%\npm`; the
    // literal spelling is kept as a fallback for a host that does not export
    // APPDATA (a service account, a stripped CI container).
    ...under(appData, 'npm'),
    join(home, 'AppData', 'Roaming', 'npm'),
    ...under(localAppData, 'pnpm'),
    ...under(localAppData, 'Yarn', 'bin'),
    join(home, '.bun', 'bin'),

    // Windows package managers.
    join(home, 'scoop', 'shims'),
    ...under(env.SCOOP, 'shims'),
    ...under(env.SCOOP_GLOBAL ?? programData, 'scoop', 'shims'),
    ...under(programData, 'chocolatey', 'bin'),
    // WinGet portable packages land here; `WindowsApps` only ever holds MSIX
    // aliases, so both are needed and neither substitutes for the other.
    ...under(localAppData, 'Microsoft', 'WinGet', 'Links'),
    ...under(localAppData, 'Microsoft', 'WindowsApps'),

    // Version managers. Volta's Windows home is not the POSIX `~/.volta`.
    ...under(localAppData, 'Volta', 'bin'),
    join(home, '.volta', 'bin'),
  ];
}

/**
 * Exported for test: the Windows arm cannot be exercised from a Linux CI box
 * through {@link augmentedPath}, which reads `process.platform` and the real
 * environment. Production always calls it through the no-argument form.
 */
export function wellKnownBinDirs(deps: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32') return posixBinDirs();
  return [...new Set(windowsBinDirs(deps.env ?? process.env, deps.home ?? os.homedir()))];
}

async function loginShellPath(execImpl: ExecFn): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/sh';
  try {
    // Markers isolate $PATH from any profile noise (motd, echo in .zprofile…).
    const { stdout } = await execImpl(
      `${shell} -l -c 'echo "${PATH_MARKER}$PATH${PATH_MARKER}"'`,
      { timeout: LOGIN_SHELL_TIMEOUT_MS },
    );
    const match = stdout.match(new RegExp(`${PATH_MARKER}([^\\n]*)${PATH_MARKER}`));
    return match?.[1] || null;
  } catch {
    return null;
  }
}

let cachedPath: Promise<string> | null = null;

/**
 * The augmented PATH for spawning user-installed CLI tools. Resolved once per
 * process and cached (the login shell query costs ~50-200ms).
 */
export function augmentedPath(execImpl: ExecFn = defaultExec): Promise<string> {
  if (!cachedPath) {
    cachedPath = (async () => {
      const segments: string[] = [];
      const push = (p: string | null | undefined) => {
        if (!p) return;
        for (const seg of p.split(path.delimiter)) {
          if (seg && !segments.includes(seg)) segments.push(seg);
        }
      };
      push(process.env.PATH);
      push(await loginShellPath(execImpl));
      for (const dir of wellKnownBinDirs()) push(dir);
      return segments.join(path.delimiter);
    })();
  }
  return cachedPath;
}

/** Test seam: drop the per-process cache so the next call re-resolves. */
export function clearAugmentedPathCache(): void {
  cachedPath = null;
}

/**
 * Build a child environment whose PATH is `resolvedPath`, with exactly one
 * PATH-ish key in it.
 *
 * `{ ...process.env, PATH }` is the obvious spelling and it is wrong on
 * Windows. Node's `process.env` is a case-insensitive proxy, but spreading it
 * yields the OS's actual casing — `Path` — so adding `PATH` produces an
 * environment block carrying both. Which one the child sees is undefined, and
 * the loser is silently discarded. Every existing site passed the same value
 * under both keys, so the bug was latent rather than live; this makes it
 * impossible instead of unlikely.
 */
export function withPath(
  base: NodeJS.ProcessEnv,
  resolvedPath: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Both sources are filtered, not just `base`: an `overrides` map carrying its
  // own PATH is exactly how the duplicate reappears.
  for (const source of [base, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.toLowerCase() === 'path') continue;
      env[key] = value;
    }
  }
  // Windows canonically spells it `Path`; POSIX requires `PATH`. Matching the
  // platform keeps anything downstream that reads the raw block unsurprised.
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = resolvedPath;
  return env;
}
