import { isCredentialVariable } from '../../credentialEnv';
import { researchToolsPath, type ResearchShell } from '../../../researchShell';
import { envValue, withPath } from '../../../../utils/shellPath';

/**
 * Variables an ordinary build, test or git command needs, by name. An
 * allowlist, not a copy of `process.env` minus a blocklist: a secret nobody
 * thought to name stays out, which is the only way "never sees a provider
 * key" can hold (ADR-0061 H1). The built-in runner holds its provider keys in
 * this very process, so the shell is the one place they could leak by
 * inheritance.
 */
const ALLOWED_NAMES = new Set([
  // Identity, locale, terminal, time.
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'CI',
  // Temp directories.
  'TMPDIR', 'TMP', 'TEMP',
  // XDG base directories, which tools use to find their own config and caches.
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  // Toolchains: where each language's own binaries and caches live.
  'NVM_DIR', 'NVM_BIN', 'VOLTA_HOME', 'FNM_DIR', 'PNPM_HOME', 'NODE_PATH', 'COREPACK_HOME',
  'CARGO_HOME', 'RUSTUP_HOME', 'GOPATH', 'GOROOT', 'GOCACHE', 'GOMODCACHE', 'JAVA_HOME', 'GRADLE_USER_HOME', 'M2_HOME',
  'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PIPX_HOME', 'UV_CACHE_DIR', 'GEM_HOME', 'GEM_PATH', 'RBENV_ROOT', 'DOTNET_ROOT',
  // Windows: a process without these cannot find its own system or profile.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
]);

/** Prefixes for families of ordinary variables: `LC_ALL`, `LC_CTYPE` and the like. */
const ALLOWED_PREFIXES = ['LC_'];

const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);

/** A proxy URL may carry `user:password@`, which is a credential like any other. */
function hasUserinfo(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value.trim());
}

function allowed(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  // Checked even for an allowlisted name: the two rules must not disagree in the secret's favour.
  if (isCredentialVariable(upper)) return false;
  if (PROXY_NAMES.has(upper)) return !hasUserinfo(value);
  return ALLOWED_NAMES.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * The environment a `shell` command starts with: the allowlisted variables of
 * `base` (the context's env, normally the host's) and a PATH, with exactly one
 * PATH key (`withPath`). On Windows, under Git Bash, the shell's own utilities
 * are put in front of PATH so `grep`, `sed` and the like resolve.
 */
export function buildToolEnv(
  base: Readonly<Record<string, string | undefined>>,
  shell?: ResearchShell,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || name.toLowerCase() === 'path') continue;
    if (allowed(name, value)) kept[name] = value;
  }
  const basePath = envValue(base, 'PATH', platform);
  return withPath(kept, shell ? researchToolsPath(shell, basePath) : basePath ?? '', {}, platform);
}
