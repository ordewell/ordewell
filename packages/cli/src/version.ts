import { readFileSync } from 'fs';
import { join } from 'path';
import { seaVersion, type SeaDeps } from '@ordewell/core';

/**
 * Read off the shipped package.json rather than inlined at build time: `dist/`
 * and `src/` each sit one level under the package root, so the same lookup
 * answers from a tsup bundle and from the sources during development. The
 * standalone binary has no package.json, so it answers with the version its
 * build embedded (ADR-0065 C3).
 */
export function cliVersion(sea: SeaDeps = {}): string {
  try {
    const embedded = seaVersion(sea);
    if (embedded) return embedded;
    const pkg: unknown = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    // A version this process cannot read is not worth failing a command over —
    // `--version` still answers, and every other path ignores it entirely.
    return 'unknown';
  }
}
