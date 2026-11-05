import * as fs from 'fs';

/**
 * A path as the file system names it, for comparing two names of one place.
 * On Windows the native call resolves what the JS one keeps, an 8.3 short name
 * and the drive letter's case, and git names a folder in that resolved form.
 * Some volumes refuse the native call (a RAM disk, some network and virtual
 * file systems), where the JS one still answers. Throws for a path that is not
 * there, as both do.
 */
export function realPathOf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}
