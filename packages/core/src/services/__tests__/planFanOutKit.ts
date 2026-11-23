import type { GlobOptions, ReadFileOpts, ToolOutcome } from '../../interfaces/IFileSystem';
import { fakeFileSystem } from '../../testing';

/** A file of `n` lines. */
export const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A glob's last segment as a file name pattern: `*` any run of a name's characters. */
const nameMatcher = (pattern: string) => {
  const last = pattern.split('/').pop() ?? pattern;
  return new RegExp(`^${last.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
};

/**
 * A workspace whose reads answer as the planner's file systems do: numbered
 * lines, a size cap in KB, a line limit; and whose glob answers as the
 * daemon's PoolFileSystem does for a directory below the workspace: the files
 * whose name the pattern matches, one a line, relative to that directory, a
 * failure for a directory that does not exist, and a note when rows were cut.
 */
export function workspace(files: Record<string, string>) {
  const reads: string[] = [];
  const globs: string[] = [];
  const fs = fakeFileSystem({
    glob: async (pattern: string, opts?: GlobOptions): Promise<ToolOutcome> => {
      const dir = opts?.path ?? '.';
      globs.push(pattern === '**/*' ? dir : `${dir} ${pattern}`);
      // The workspace root lists its rows with no `./`: formatSearchOutput strips `<root>/`.
      const under = dir === '.' ? Object.keys(files) : Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
      if (under.length === 0) return { success: false, output: `Glob failed: find: '/ws/${dir}': No such file or directory`, truncated: false };
      const name = nameMatcher(pattern);
      const rows = under.filter((p) => name.test(p.split('/').pop()!));
      if (rows.length === 0) return { success: true, output: 'No files matched.', truncated: false };
      const limit = opts?.headLimit ?? 200;
      return rows.length > limit
        ? { success: true, output: `${rows.slice(0, limit).join('\n')}\n\n[showing ${limit} of ${rows.length} results.]`, truncated: true }
        : { success: true, output: rows.join('\n'), truncated: false };
    },
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
  return { fs, reads, globs };
}
