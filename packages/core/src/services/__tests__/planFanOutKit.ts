import type { ReadFileOpts, ToolOutcome } from '../../interfaces/IFileSystem';
import { fakeFileSystem } from '../../testing';

/** A file of `n` lines. */
export const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A workspace whose reads answer as the planner's file systems do: numbered lines, a size cap in KB, a line limit. */
export function workspace(files: Record<string, string>) {
  const reads: string[] = [];
  const fs = fakeFileSystem({
    readFile: async (p: string, opts?: ReadFileOpts): Promise<ToolOutcome> => {
      reads.push(p);
      const content = files[p];
      if (content === undefined) return { success: false, output: `Error reading ${p}: ENOENT`, truncated: false };
      if (Buffer.byteLength(content) > (opts?.maxBytes ?? 1024) * 1024) return { success: true, output: 'File too large (2.0 MB). Maximum is 1024 KB.', truncated: false };
      const all = content.split('\n');
      if (all[all.length - 1] === '') all.pop();
      const limit = opts?.limit ?? 2000;
      const shown = all.slice(0, limit).map((l, i) => `${String(i + 1).padStart(String(all.length).length)}|${l}`).join('\n');
      return limit < all.length
        ? { success: true, output: `${shown}\n\n(File has more lines — use offset=${limit} to read beyond line ${limit})\n`, truncated: true }
        : { success: true, output: shown, truncated: false };
    },
  });
  return { fs, reads };
}
