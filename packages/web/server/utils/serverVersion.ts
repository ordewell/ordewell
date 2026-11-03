import { readFileSync } from 'fs';
import { dirname, join } from 'path';

let cached: string | undefined;

/**
 * This daemon's `@ordewell/web` version, for `GET /api/server` (ADR-0060 H3).
 * Found by walking up to the package's own manifest rather than a fixed
 * `..`: the tsup bundle runs from `dist/server/` and the tests from
 * `server/utils/`, and a fixed hop count breaks on whichever moves next.
 */
export function serverVersion(from: string = __dirname): string {
  if (cached !== undefined) return cached;
  cached = findVersion(from);
  return cached;
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
