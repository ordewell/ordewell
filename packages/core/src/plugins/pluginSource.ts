/** Hosts a plugin may be cloned from. Exact hostname match, case-insensitive. */
export const ALLOWED_PLUGIN_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
];

/**
 * Repository paths are ordinary segments only. Anything a shell would treat as
 * special — and anything percent-encoded, which is how `new URL` renders a
 * space or a backtick — fails to match.
 */
const SAFE_REPO_PATH = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

/** Two or more scheme characters, so a Windows drive letter (`C:\`) is not a scheme. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/** scp-style git remote: `git@github.com:user/repo`. */
const SCP_LIKE_REMOTE = /^[^/\\]+@[^/\\]+:/;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type PluginSource =
  | { kind: 'git'; url: string }
  | { kind: 'path'; path: string };

/**
 * Validate a plugin repository URL. Requires an ordinary HTTPS repository on an
 * allowed host, which is also what rejects git's transport helpers (`ext::`,
 * `git://`, `ssh://`, `file://`) — they never reach the clone because they are
 * not the https scheme.
 *
 * Returns the parsed URL so callers clone the normalised form they validated.
 */
export function assertInstallablePluginUrl(url: unknown): URL {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('A plugin repository URL is required.');
  }

  if (hasControlCharacter(url)) {
    throw new Error('Plugin URL contains control characters.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Not a valid plugin repository URL: ${url}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Plugin repositories must be cloned over https (got "${parsed.protocol}//"). ` +
      `git transport helpers and non-https schemes are not accepted.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error('Plugin URL must not embed credentials.');
  }

  if (parsed.port) {
    throw new Error('Plugin URL must not specify a port.');
  }

  if (parsed.search || parsed.hash) {
    throw new Error('Plugin URL must not carry a query string or fragment.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_PLUGIN_HOSTS.includes(host)) {
    throw new Error(
      `Plugin host not allowed: ${host}. Allowed hosts: ${ALLOWED_PLUGIN_HOSTS.join(', ')}.`,
    );
  }

  if (!SAFE_REPO_PATH.test(parsed.pathname)) {
    throw new Error(`Not a plain repository path: ${parsed.pathname}`);
  }

  return parsed;
}

/**
 * Decide whether an install source names a remote repository or a local
 * directory. Anything that carries a scheme or looks like an scp-style remote
 * goes down the URL route so it is rejected as a bad URL rather than silently
 * retried as a (nonexistent) directory.
 */
export function classifyPluginSource(source: string): PluginSource {
  const trimmed = source.trim();

  if (trimmed.startsWith('github:')) {
    const repo = trimmed.slice('github:'.length).replace(/\.git$/, '');
    return { kind: 'git', url: `https://github.com/${repo}.git` };
  }

  if (HAS_SCHEME.test(trimmed) || SCP_LIKE_REMOTE.test(trimmed)) {
    return { kind: 'git', url: trimmed };
  }

  return { kind: 'path', path: source };
}
