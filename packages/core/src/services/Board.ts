import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BOARD_LIMITS, BOARD_REF, boardEntryLines, boardMapLines, boardRef, contestedKeys, parseBoardRef, pinLines, type BoardAuthor, type BoardDraft, type BoardEntry, type BoardFile, type BoardMarks, type BoardPost } from '../models/Board';
import { parentPath, type NodePath } from '../models/TreeEvent';
import type { McpToolReply } from './mcp/tools';
import { allowedPath } from './taskDiffRead';

/** Where the board's `file` evidence is compared (ADR-0057 R9). */
export interface BoardGit {
  /** The branch this node's plan lands on; undefined with no run yet. */
  branch(): string | undefined;
  /** The blob `file` holds on `branch`: null where it holds none, undefined where the branch cannot be read. */
  blob(branch: string, file: string): Promise<string | null | undefined>;
}

/** The log's side of a board. */
export interface BoardLog {
  post(node: NodePath, draft: BoardDraft): BoardEntry | null;
  board(node: NodePath): readonly BoardEntry[];
}

export interface NodeBoardDeps {
  log: BoardLog;
  node: NodePath;
  git: BoardGit;
  /** What this plan's checks read and run: what no pin may hold (R10). */
  checks?(): readonly string[];
}

/** Past this a file is not read: a claim on it goes unpinned, and is never stale. */
const BLOB_READ_MAX = 16 * 1024 * 1024;

/**
 * The blob of `file` in `cwd`, as git would name it, read with no git: a
 * read-only task's sealed runs may have planted a repository in its worktree
 * (ADR-0046). A file a clean filter rewrites hashes as it stands, so it can read
 * stale once landed, which a scope's being advisory covers.
 */
function workBlob(cwd: string, file: string): string | undefined {
  try {
    const root = fs.realpathSync(cwd);
    const full = fs.realpathSync(path.join(root, file));
    if (!full.startsWith(`${root}${path.sep}`)) return undefined;
    const { size } = fs.statSync(full);
    if (size > BLOB_READ_MAX) return undefined;
    const bytes = fs.readFileSync(full);
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

/** How a text stands for a match: case and spacing are not what makes a check the same check. */
const folded = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Shorter than this, a check's words are too common to say a pin holds them. */
const CHECK_TEXT_MIN = 12;

/**
 * One node's view of the tree's boards (ADR-0057 R8 to R10): it posts to its
 * own, and reads that and its ancestors' by pull. Nothing here wakes or tells
 * anyone, so it is no channel between siblings (R7). What is stale or contested
 * is worked out here, as a reader asks, from what the log and git hold.
 */
export class NodeBoard {
  constructor(private readonly deps: NodeBoardDeps) {}

  get node(): NodePath {
    return this.deps.node;
  }

  /** Nearest first: this node, then each ancestor. */
  private chain(): NodePath[] {
    const nodes: NodePath[] = [];
    for (let at: NodePath | null = this.deps.node; at !== null; at = parentPath(at)) nodes.push(at);
    return nodes;
  }

  private readable(): BoardEntry[] {
    return this.chain().flatMap((node) => this.deps.log.board(node));
  }

  /** The file evidence an entry pins, read now: what its author saw and what the branch held. */
  private async pinned(files: readonly string[], cwd: string | undefined, branch: string | undefined): Promise<BoardFile[]> {
    return Promise.all(files.map(async (file): Promise<BoardFile> => {
      const sha = cwd === undefined ? undefined : workBlob(cwd, file);
      const tip = branch === undefined ? undefined : await this.deps.git.blob(branch, file);
      return { kind: 'file', path: file, ...(sha ? { sha } : {}), ...(tip ? { tip } : {}) };
    }));
  }

  /** Why this may not be posted, or null. */
  private refusal({ type, title, detail, files }: BoardPost): string | null {
    const unsafe = files?.find((file) => !allowedPath(file));
    if (unsafe !== undefined) return `files: ${JSON.stringify(unsafe)} is not a path in this workspace: give one relative to it, with no "..".`;
    if (type !== 'pin') return null;
    const said = folded(`${title}\n${detail ?? ''}`);
    return (this.deps.checks?.() ?? []).some((text) => folded(text).length >= CHECK_TEXT_MIN && said.includes(folded(text)))
      ? 'A check never goes in a pin: a pin reaches the tasks a check judges, and a check they can read is one they can pass without the work. Nothing was posted.'
      : null;
  }

  /** `cwd` is where the author works: its files are pinned from there (R9). */
  async post(entry: BoardPost, by: Omit<BoardAuthor, 'node'>, cwd?: string): Promise<McpToolReply> {
    const refused = this.refusal(entry);
    if (refused) return { text: refused, isError: true };
    const { files, ...fields } = entry;
    const branch = this.deps.git.branch();
    const draft: BoardDraft = {
      ...fields,
      by: { ...by, node: this.deps.node },
      ...(files?.length ? { files: await this.pinned(files, cwd, branch), ...(branch ? { branch } : {}) } : {}),
    };
    const posted = this.deps.log.post(this.deps.node, draft);
    if (!posted) return { text: `This board is full, at ${BOARD_LIMITS.entries} entries: nothing was posted.`, isError: true };
    return { text: `Posted ${boardRef(posted)}. Nobody was told: it waits for whoever reads the board.` };
  }

  /** Whether a pinned file has moved past what its entry was written on. */
  private async stale(entry: BoardEntry, blobs: Map<string, Promise<string | null | undefined>>): Promise<boolean> {
    const { branch, files } = entry;
    if (!branch || !files) return false;
    for (const { path: file, sha, tip } of files) {
      if (sha === undefined && tip === undefined) continue;
      const at = `${branch}\0${file}`;
      const read = blobs.get(at) ?? this.deps.git.blob(branch, file);
      blobs.set(at, read);
      const now = await read;
      if (now === undefined) continue;
      // Still what the branch held, or what its author wrote: nothing else has moved it, landed or not.
      if ((now ?? undefined) !== tip && now !== sha) return true;
    }
    return false;
  }

  private async marked(entries: readonly BoardEntry[]): Promise<{ entry: BoardEntry; marks: BoardMarks }[]> {
    const contested = contestedKeys(this.readable());
    const blobs = new Map<string, Promise<string | null | undefined>>();
    return Promise.all(entries.map(async (entry) => ({
      entry,
      marks: { stale: await this.stale(entry, blobs), contested: entry.key !== undefined && contested.has(entry.key) },
    })));
  }

  /** `read` of `board`, or of one entry by its reference. */
  async read(written: string): Promise<McpToolReply> {
    if (written === BOARD_REF) {
      const all = this.readable();
      return { text: boardMapLines(this.chain(), await this.marked(all.slice(0, BOARD_LIMITS.mapped)), all.length - BOARD_LIMITS.mapped).join('\n') };
    }
    const ref = parseBoardRef(written);
    const entry = ref && this.readable().find((one) => one.node === ref.node && one.id === ref.id);
    if (!entry) return { text: `${JSON.stringify(written)} names no entry of this board or the boards above it: read "${BOARD_REF}" for what they hold.`, isError: true };
    const [{ marks }] = await this.marked([entry]);
    return { text: boardEntryLines(entry, marks).join('\n') };
  }

  /** The pins a new descendant of this node is told (R10). */
  pins(): string[] {
    return pinLines(this.readable().filter((entry) => entry.type === 'pin'));
  }

  /**
   * A delegated task's `contract`s for what it provides, onto this board as it
   * lands (R6), which is how a sibling reads them: a node reads its ancestors'
   * boards and never another's. Each keeps its author, and is read again against
   * the branch it has landed on. Only what the plan declared rises, and only once.
   */
  async raise(from: readonly BoardEntry[], provides: readonly string[]): Promise<void> {
    const branch = this.deps.git.branch();
    const held = this.deps.log.board(this.deps.node);
    for (const entry of from) {
      if (entry.type !== 'contract' || entry.key === undefined || !provides.includes(entry.key)) continue;
      if (held.some(({ raisedFrom }) => raisedFrom?.node === entry.node && raisedFrom.id === entry.id)) continue;
      const { node, id, at: _at, files, branch: _branch, ...fields } = entry;
      const repinned = files && await Promise.all(files.map(async (file) => {
        const tip = branch === undefined ? undefined : await this.deps.git.blob(branch, file.path);
        return { ...file, ...(tip ? { tip } : {}) };
      }));
      this.deps.log.post(this.deps.node, { ...fields, raisedFrom: { node, id }, ...(repinned ? { files: repinned, ...(branch ? { branch } : {}) } : {}) });
    }
  }
}
