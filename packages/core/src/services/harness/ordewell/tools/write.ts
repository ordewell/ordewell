import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lockKey, withFileLock } from './fileLock';
import { display, PathRefusal, resolveWritable } from './paths';
import type { OrdewellTool } from './types';

export const writeTool: OrdewellTool = {
  name: 'write',
  description: 'Create a file, or replace an existing one whole, with the given content. Missing parent directories are created. To change part of an existing file, use edit.',
  effect: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to write, relative to the worktree.' },
      content: { type: 'string', description: 'The complete new content of the file.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const raw = String(args.path);
    const content = String(args.content);
    let file: string;
    try {
      file = resolveWritable(context, raw);
    } catch (err) {
      if (err instanceof PathRefusal) return { text: err.message, isError: true };
      throw err;
    }
    // Same key as edit, so a write and an edit of one file never interleave.
    return withFileLock(lockKey(file), async () => {
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) return { text: `${raw} is a directory, not a file.`, isError: true };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      const bytes = Buffer.byteLength(content);
      return {
        text: `${info ? 'Overwrote' : 'Created'} ${display(context, file)} (${bytes} bytes).`,
        isError: false,
        details: { path: file, created: !info, bytes },
      };
    });
  },
};
