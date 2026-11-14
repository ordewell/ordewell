import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES } from './output';
import { display, PathRefusal, resolveReadable } from './paths';
import type { OrdewellTool, ToolResult } from './types';

const MAX_LINE_CHARS = 2000;
const BINARY_PROBE_BYTES = 8192;
const MAX_SUGGESTIONS = 3;

function failure(text: string): ToolResult {
  return { text, isError: true };
}

async function looksBinary(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, BINARY_PROBE_BYTES, 0);
    return probe.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** Names beside a missing path that it was probably meant to be. */
async function nearbyNames(missing: string): Promise<string[]> {
  const wanted = path.basename(missing).toLowerCase();
  try {
    const names = await readdir(path.dirname(missing));
    return names
      .map((name) => ({ name, lower: name.toLowerCase() }))
      .filter(({ lower }) => wanted.length >= 2 && (lower.includes(wanted) || wanted.includes(lower) || editDistance(lower, wanted) <= Math.max(2, Math.floor(wanted.length / 4))))
      .slice(0, MAX_SUGGESTIONS)
      .map(({ name }) => path.join(path.dirname(missing), name));
  } catch {
    return [];
  }
}

async function listDirectory(dir: string): Promise<ToolResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  const named = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  // A symlink to a directory shows as a directory, as `ls` users expect.
  await Promise.all(entries.filter((e) => e.isSymbolicLink()).map(async (e, i) => {
    const target = await stat(path.join(dir, e.name)).catch(() => null);
    const entry = named.find((n) => n.name === e.name);
    if (entry && target?.isDirectory()) entry.dir = true;
    return i;
  }));
  named.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { text: named.map((e) => (e.dir ? `${e.name}/` : e.name)).join('\n'), isError: false, details: { entries: named.length } };
}

/** One page of `file`: from line `offset`, up to `limit` lines and a page's bytes, streamed so a huge file is never held whole. */
async function readPage(file: string, offset: number, limit: number): Promise<ToolResult> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const shown: string[] = [];
  let bytes = 0;
  let lineNo = 0;
  let next: number | null = null;
  try {
    for await (const text of lines) {
      lineNo += 1;
      if (lineNo < offset) continue;
      const clipped = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… (line truncated, ${text.length} characters)` : text;
      const row = `${lineNo}: ${clipped}`;
      const size = Buffer.byteLength(row) + 1;
      if (shown.length >= limit || shown.length >= MAX_OUTPUT_LINES || (shown.length > 0 && bytes + size > MAX_OUTPUT_BYTES - 200)) {
        next = lineNo;
        break;
      }
      shown.push(row);
      bytes += size;
    }
  } finally {
    lines.close();
  }
  if (shown.length === 0) {
    return failure(`offset ${offset} is past the end of the file (${lineNo} lines).`);
  }
  const last = offset + shown.length - 1;
  const footer = next === null
    ? `(End of file - ${last} lines)`
    : `(Showing lines ${offset}-${last}. Use offset=${next} to continue.)`;
  return { text: `${shown.join('\n')}\n\n${footer}`, isError: false, paged: true, details: { firstLine: offset, lastLine: last, endOfFile: next === null } };
}

export const readTool: OrdewellTool = {
  name: 'read',
  description: `Read a file or list a directory. Files print as "N: line". A page is up to ${MAX_OUTPUT_LINES} lines; when there is more, the end of the output names the offset to continue from. A directory lists its entries, directories first with a trailing slash. Paths are relative to the worktree. Use this rather than cat or ls in the shell.`,
  effect: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to read, relative to the worktree or absolute.' },
      offset: { type: 'number', description: 'Line number (1-based) to start from. Default 1.' },
      limit: { type: 'number', description: `Most lines to return. Default and maximum ${MAX_OUTPUT_LINES}.` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const raw = String(args.path);
    let file: string;
    try {
      file = resolveReadable(context, raw);
    } catch (err) {
      if (err instanceof PathRefusal) return failure(err.message);
      throw err;
    }
    const info = await stat(file).catch(() => null);
    if (!info) {
      const near = await nearbyNames(file);
      const hint = near.length ? ` Did you mean ${near.map((n) => display(context, n)).join(', ')}?` : '';
      return failure(`${raw} does not exist.${hint}`);
    }
    if (info.isDirectory()) return listDirectory(file);
    if (await looksBinary(file)) {
      return { text: `${raw} is a binary file (${info.size} bytes); its contents are not shown.`, isError: false, details: { binary: true, bytes: info.size } };
    }
    const offset = typeof args.offset === 'number' ? Math.max(1, Math.floor(args.offset)) : 1;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(MAX_OUTPUT_LINES, Math.floor(args.limit))) : MAX_OUTPUT_LINES;
    return readPage(file, offset, limit);
  },
};
