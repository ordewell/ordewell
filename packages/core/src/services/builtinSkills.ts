import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Absolute path to the skills dir shipped with this package. In the published
 * layout the skills live at the package root (a sibling of dist/), so it is
 * resolved from this compiled module's own location — `__dirname` under CJS,
 * `import.meta.url` under ESM — rather than from the current working directory,
 * which is wrong whenever the binary is invoked from somewhere else.
 */
export function builtinSkillsDir(): string {
  // CJS has __dirname; ESM (the other shipped format) locates itself via
  // import.meta. The tsconfig typechecks as commonjs, where import.meta is
  // disallowed, so the ESM branch is suppressed here but preserved in the build.
  const dir = typeof __dirname !== 'undefined' && __dirname
    ? __dirname
    : path.dirname(fileURLToPath(
        // @ts-expect-error - import.meta is only valid under an ESM module setting
        (import.meta as { url: string }).url,
      ));
  return path.join(dir, '..', 'skills');
}
