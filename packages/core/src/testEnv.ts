import * as fs from 'fs';
import * as path from 'path';

/**
 * The variables that make `home` the user's home, for a test that gives this
 * process, or a child, a home of its own.
 *
 * HOME alone is a POSIX home. Node's `os.homedir()` reads USERPROFILE on
 * Windows, so a test that set only HOME there read and wrote the real
 * `~/.ordewell`. The per-user folders the runner probe searches on Windows
 * (`wellKnownBinDirs`: npm's prefix under APPDATA, WinGet's links under
 * LOCALAPPDATA, Chocolatey's under ProgramData, Scoop's own) hang off variables
 * of their own, so those move too, or a CLI really installed there is found.
 */
export function homeEnv(home: string, platform: NodeJS.Platform = process.platform): Record<string, string | undefined> {
  if (platform !== 'win32') return { HOME: home };
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.win32.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(home, 'AppData', 'Local'),
    ProgramData: path.win32.join(home, 'ProgramData'),
    SCOOP: undefined,
    SCOOP_GLOBAL: undefined,
  };
}

/**
 * Set `vars` on this process's environment, and return what puts back the
 * values they replaced. A key given as undefined is deleted: assigning
 * undefined to `process.env` stores the string "undefined".
 */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  applyEnv(vars);
  return () => applyEnv(saved);
}

function applyEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * A PATH on which `command` starts the fake in `dir`.
 *
 * First on PATH is enough on POSIX. A fake is a batch shim on Windows, and
 * `planDirectLaunch` prefers a native executable anywhere on PATH to a batch
 * shim ahead of it (ADR-0010), so every directory holding a native `command`
 * is left out as well. With {@link homeEnv}, nothing installed on the machine
 * answers in the fake's place.
 */
export function pathWithFake(
  dir: string,
  command: string,
  PATH: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const native = platform === 'win32' ? ['.exe', '.com'] : [];
  const holdsNative = (entry: string) => native.some((ext) => fs.existsSync(paths.join(entry.replace(/^"|"$/g, ''), `${command}${ext}`)));
  return [dir, ...PATH.split(paths.delimiter).filter((entry) => entry && !holdsNative(entry))].join(paths.delimiter);
}
