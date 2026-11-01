import { onOneLine } from '../models/lineBreaks';

/**
 * Pure helper so a browser surface can format a conflict's files without
 * pulling `isolationRecord` — and its `path` import — into a webview bundle.
 * Kept out of `isolationRecord.ts` for exactly that reason.
 */
export function capConflictFiles(files: string[], max = 5): string {
  const named = files.map(onOneLine);
  return named.length <= max ? named.join(', ') : `${named.slice(0, max).join(', ')}, +${named.length - max} more`;
}
