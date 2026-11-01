import type { BoardEntry } from './Board';

/**
 * A live session's allowance for what it has in flight (ADR-0056 M5), which is
 * one model call: a long context's prompt, its cache reads included, and a reply.
 * An estimate: a runner's own subagents add requests nobody sees until their
 * usage arrives.
 */
export const SESSION_RESERVE_TOKENS = 200_000;

/*
 * What a tree's log holds (ADR-0058 S3). State is a fold of these, so an event
 * says what was decided, amounts included, and a replay decides nothing. A new
 * kind is a new member of the union: a fold passes over what it does not read.
 */

/** A node's place among its parent's children, counted from 1 and never reused or moved. */
export type NodeId = string;

/** `root/3/2`: the ids from the root down. A node's parent never changes, so neither does this. */
export type NodePath = string;

export const ROOT_NODE: NodePath = 'root';

export function childPath(parent: NodePath, id: NodeId): NodePath {
  return `${parent}/${id}`;
}

/** The parent of `node`, or null for the root. */
export function parentPath(node: NodePath): NodePath | null {
  const at = node.lastIndexOf('/');
  return at === -1 ? null : node.slice(0, at);
}

/** Whether `node` is `ancestor` or under it. */
export function isWithin(node: NodePath, ancestor: NodePath): boolean {
  return node === ancestor || node.startsWith(`${ancestor}/`);
}

interface OfNode {
  /** When it was written: for a reader, and never read by a fold. */
  at: string;
  node: NodePath;
}

export type TreeFact = OfNode & (
  /** A node joined the tree. Below the root its `limit` is carved from its parent, and `kept` of it stays for the subplanner's next turn (ADR-0056 M5). */
  | { kind: 'node_opened'; sessionId: string; taskId?: string; limit: number; kept: number }
  /** `node` confirmed closed: its parent holds its `limit` no longer, and is charged what it spent. */
  | { kind: 'node_closed' }
  /** Tokens as a runner or planner reported them. A turn spends what its node kept first. */
  | { kind: 'tokens_spent'; tokens: number; turn?: true; taskId?: string; attempt?: number }
  /** A raise: `tokens` more on `node`'s limit, from its parent's room. */
  | { kind: 'budget_raised'; tokens: number }
  /** Its parent's own spending took `tokens` of `node`'s room: `node`'s limit and its parent's `committed` fall together. */
  | { kind: 'budget_taken'; tokens: number }
  /** A subplanner parked, keeping `tokens` more for its next turn. */
  | { kind: 'reserve_kept'; tokens: number }
  /** The user set the root's limit, the tree's budget, to `limit`. */
  | { kind: 'limit_set'; limit: number }
  /** An entry on `node`'s board, whole: a board is a fold of these (ADR-0057 R8). */
  | { kind: 'board_posted'; entry: BoardEntry }
);

/** A fact as the log holds it: `seq` is its place in the tree's one order, from 1. */
export type TreeEvent = TreeFact & { seq: number };
