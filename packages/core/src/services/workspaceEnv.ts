import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { STATE_DIR } from '../utils/fsHelpers';
import { SETTINGS_ENV_REFUSED } from './settingsEnvAllowlist';

/** `.ordewell/env`: the workspace's own variables for its planner and agents, never committed. */
export const WORKSPACE_ENV_FILE = 'env';

const DIRENV_TIMEOUT_MS = 5_000;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables one workspace's planner and agents run with, on top of the
 * daemon's own environment (ADR-0016).
 *
 * The daemon and the VS Code host inherit whatever environment they were
 * started from, once. Started anywhere but the project's shell — a desktop
 * launcher, another directory, a daemon already up for another project — they
 * miss what the project sets for itself, like a `CLAUDE_CONFIG_DIR` choosing
 * the account the agents run under. So each spawn asks for it by its own cwd:
 * a task worktree lives under the workspace, so walking up finds the same
 * `.envrc` and `.ordewell/env` the workspace root does.
 */
export interface WorkspaceEnv {
  env: Record<string, string>;
  /** An `.envrc` direnv refuses to load until the user allows it. */
  blockedEnvrc: string | null;
  /** Keys dropped because they would change how processes load or where Ordewell's own settings live. */
  refused: string[];
  /** An `.ordewell/env` ignored because git tracks it — a cloned repository must not choose these. */
  trackedEnvFile: string | null;
}

export interface WorkspaceEnvDeps {
  run(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(file: string): string | null;
  isDirectory(dir: string): boolean;
  baseEnv: NodeJS.ProcessEnv;
  home: string;
}

function defaultDeps(): WorkspaceEnvDeps {
  return {
    run: (command, args, opts) => new Promise((resolve) => {
      execFile(command, args, { ...opts, timeout: DIRENV_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : -1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    }),
    readFile: (file) => {
      try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
    },
    isDirectory: (dir) => {
      try { return fs.statSync(dir).isDirectory(); } catch { return false; }
    },
    baseEnv: process.env,
    home: os.homedir(),
  };
}

const REFUSED = new Set(SETTINGS_ENV_REFUSED);

export async function resolveWorkspaceEnv(cwd: string, overrides: Partial<WorkspaceEnvDeps> = {}): Promise<WorkspaceEnv> {
  const deps = { ...defaultDeps(), ...overrides };
  const result: WorkspaceEnv = { env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null };
  if (!deps.isDirectory(cwd)) return result;

  const collected: Record<string, string> = {};
  const direnv = await fromDirenv(checkoutDirOf(cwd, deps), deps);
  result.blockedEnvrc = direnv.blocked;
  Object.assign(collected, direnv.env);

  const file = findUp(cwd, path.join(STATE_DIR, WORKSPACE_ENV_FILE), deps);
  if (file) {
    const content = deps.readFile(file);
    if (content !== null) {
      if (await isTracked(file, deps)) result.trackedEnvFile = file;
      else Object.assign(collected, parseEnvFile(content, { ...deps.baseEnv, ...collected }, deps.home));
    }
  }

  for (const [key, value] of Object.entries(collected)) {
    // Only names pass: a key is handed on as an environment variable name.
    if (!KEY.test(key)) continue;
    if (REFUSED.has(key) || key.toUpperCase() === 'PATH') result.refused.push(key);
    else result.env[key] = value;
  }
  return result;
}

/** Just the variables, for a spawn path that has nowhere to report the rest. */
export async function workspaceEnvOf(cwd: string): Promise<Record<string, string>> {
  return (await resolveWorkspaceEnv(cwd)).env;
}

/**
 * The directory in the user's own checkout a task worktree stands for:
 * `<root>/.ordewell/worktrees/<run>/<task>/<rest>` is `<root>/<rest>`. direnv
 * is asked there, not in the worktree, because an allowed `.envrc` is allowed
 * at its own path only — the worktree's linked copy is a path direnv has never
 * been told about, and it would report it blocked.
 */
function checkoutDirOf(cwd: string, deps: WorkspaceEnvDeps): string {
  const parts = path.resolve(cwd).split(path.sep);
  const at = parts.findIndex((part, i) => part === STATE_DIR && parts[i + 1] === 'worktrees');
  if (at < 0 || parts.length < at + 4) return cwd;
  const root = parts.slice(0, at).join(path.sep) || path.sep;
  const mapped = path.join(root, ...parts.slice(at + 4));
  return deps.isDirectory(mapped) ? mapped : root;
}

/**
 * direnv's own answer for this directory, computed afresh: the daemon's
 * environment may carry a DIRENV_* state from wherever it was started, and
 * against that direnv would answer with a diff, or with nothing at all.
 */
async function fromDirenv(cwd: string, deps: WorkspaceEnvDeps): Promise<{ env: Record<string, string>; blocked: string | null }> {
  const setting = deps.baseEnv.ORDEWELL_DIRENV;
  if (setting === 'false' || setting === '0') return { env: {}, blocked: null };
  const baseEnv = Object.fromEntries(Object.entries(deps.baseEnv).filter(([key]) => !key.startsWith('DIRENV_')));
  let out: { code: number; stdout: string; stderr: string };
  try {
    out = await deps.run('direnv', ['export', 'json'], { cwd, env: baseEnv });
  } catch {
    return { env: {}, blocked: null };
  }
  const blocked = out.stderr.match(/error (\S*\.envrc) is blocked/);
  if (blocked) return { env: {}, blocked: blocked[1] };
  if (out.code !== 0 || !out.stdout.trim()) return { env: {}, blocked: null };
  let parsed: unknown;
  try { parsed = JSON.parse(out.stdout); } catch { return { env: {}, blocked: null }; }
  if (!parsed || typeof parsed !== 'object') return { env: {}, blocked: null };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && !key.startsWith('DIRENV_')) env[key] = value;
  }
  return { env, blocked: null };
}

function findUp(start: string, relative: string, deps: WorkspaceEnvDeps): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, relative);
    if (deps.readFile(candidate) !== null) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function isTracked(file: string, deps: WorkspaceEnvDeps): Promise<boolean> {
  try {
    const out = await deps.run('git', ['ls-files', '--error-unmatch', path.basename(file)], { cwd: path.dirname(file), env: deps.baseEnv });
    return out.code === 0;
  } catch {
    return false;
  }
}

/**
 * dotenv lines: `KEY=value`, optionally `export`ed. Single quotes are literal;
 * double-quoted and bare values expand `$VAR`, `${VAR}` and a leading `~/`.
 */
export function parseEnvFile(content: string, context: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lookup = (name: string): string => env[name] ?? context[name] ?? '';
  const expand = (value: string): string => {
    const tilde = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
    return tilde.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => lookup(braced ?? bare));
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    const rest = line.slice(eq + 1).trim();
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      env[key] = end > 0 ? rest.slice(1, end) : rest.slice(1);
    } else if (rest.startsWith('"')) {
      const end = rest.lastIndexOf('"');
      env[key] = expand((end > 0 ? rest.slice(1, end) : rest.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    } else {
      env[key] = expand(rest.replace(/\s+#.*$/, ''));
    }
  }
  return env;
}
