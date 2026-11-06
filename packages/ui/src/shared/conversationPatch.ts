import type { DisplayBlock } from '@ordewell/core';
import type { ConversationPatch } from './protocol';

/** The webview's copy of the conversation, rebuilt only from patches. */
export interface PatchedView {
  readonly order: readonly string[];
  readonly byId: Readonly<Record<string, DisplayBlock>>;
}

export const EMPTY_PATCHED_VIEW: PatchedView = { order: [], byId: {} };

/**
 * What the webview is missing, given the blocks it was last sent. The core
 * reducer returns an untouched block as the same object, so identity alone
 * says what changed — a streamed delta sends the one block it grew.
 * Null when there is nothing to send.
 */
export function diffConversation(sent: readonly DisplayBlock[], next: readonly DisplayBlock[]): ConversationPatch | null {
  const before = new Map(sent.map((b) => [b.id, b]));
  const changed = next.filter((b) => before.get(b.id) !== b);
  const sameOrder = sent.length === next.length && next.every((b, i) => sent[i].id === b.id);
  if (changed.length === 0 && sameOrder) return null;
  return { type: 'conversationPatch', order: next.map((b) => b.id), changed };
}

export function applyConversationPatch(view: PatchedView, patch: ConversationPatch): PatchedView {
  const changed = new Map(patch.changed.map((b) => [b.id, b]));
  const byId: Record<string, DisplayBlock> = {};
  for (const id of patch.order) {
    const block = changed.get(id) ?? view.byId[id];
    if (block) byId[id] = block;
  }
  return { order: patch.order, byId };
}

export function patchedBlocks(view: PatchedView): DisplayBlock[] {
  return view.order.flatMap((id) => (view.byId[id] ? [view.byId[id]] : []));
}
