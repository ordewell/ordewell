import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Read off the shipped package.json rather than inlined at build time: `dist/`
 * and `src/` each sit one level under the package root, so the same lookup
 * answers from a tsup bundle and from the sources during development.
 */
export function cliVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    // A version this process cannot read is not worth failing a command over —
    // `--version` still answers, and every other path ignores it entirely.
    return 'unknown';
  }
}
