import { isAbsolute, relative, sep } from 'node:path';

/** Whether `file` lies strictly inside `root`: a `..` in a request path never reaches outside the bundle. */
export function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}
