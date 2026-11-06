import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { seaVersion, type SeaDeps } from '@ordewell/core';

let cached: string | undefined;

/**
 * This daemon's `@ordewell/web` version, for `GET /api/server` (ADR-0063 H3).
 * Found by walking up to the package's own manifest rather than a fixed
 * `..`: the tsup bundle runs from `dist/server/` and the tests from
 * `server/utils/`, and a fixed hop count breaks on whichever moves next.
 * Inside the standalone binary there is no manifest to walk to, and the daemon
 * is the binary itself, so its version is the one the build embedded.
 */
export function serverVersion(from: string = __dirname, sea: SeaDeps = {}): string {
  const embedded = embeddedVersion(sea);
  if (embedded) return embedded;
  if (cached !== undefined) return cached;
  cached = findVersion(from);
  return cached;
}

function embeddedVersion(sea: SeaDeps): string | undefined {
  try {
    return seaVersion(sea);
  } catch {
    // A binary whose manifest cannot be read still answers the API.
    return 'unknown';
  }
}

function findVersion(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const { name, version } = pkg as { name?: unknown; version?: unknown };
      if (name === '@ordewell/web' && typeof version === 'string' && version) return version;
    } catch {
      // No manifest here, or not one we can read: keep walking.
    }
    if (dirname(dir) === dir) return 'unknown';
  }
}
