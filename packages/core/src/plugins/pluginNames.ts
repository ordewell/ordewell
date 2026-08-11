import * as path from 'path';

/**
 * A plugin name is a single plain path segment: alphanumeric at both ends,
 * dots/dashes/underscores in between. This is what keeps a manifest name from
 * being a traversal sequence (`..`, `../../etc`), an absolute path, or a
 * dash-prefixed string that a downstream tool reads as a flag.
 */
export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const MAX_PLUGIN_NAME_LENGTH = 64;

export function isPlainPluginName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length <= MAX_PLUGIN_NAME_LENGTH &&
    PLUGIN_NAME_PATTERN.test(name)
  );
}

export function assertPlainPluginName(name: unknown): asserts name is string {
  if (!isPlainPluginName(name)) {
    throw new Error(
      `Invalid plugin name: ${JSON.stringify(name)}. ` +
      `Names must be a single plain segment of letters, digits, '.', '-' or '_' ` +
      `(max ${MAX_PLUGIN_NAME_LENGTH} characters).`,
    );
  }
}

/**
 * Resolve where a plugin of this name installs, and assert the result is still
 * a direct child of the plugins directory. Validation and use share this one
 * call so they cannot disagree about the path being checked.
 */
export function resolvePluginInstallDir(pluginsDir: string, name: unknown): string {
  assertPlainPluginName(name);

  const root = path.resolve(pluginsDir);
  const dest = path.resolve(root, name);
  const relative = path.relative(root, dest);

  if (relative !== name || relative === '' || path.isAbsolute(relative)) {
    throw new Error(`Plugin install path escapes the plugins directory: ${JSON.stringify(name)}`);
  }

  return dest;
}
