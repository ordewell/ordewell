/*
 * One checkout action's result reaches the files list and every open checkout
 * diff, whichever of them started it: the sidebar redraws, and a diff tab
 * rereads its patch after a hunk moved between the index and the tree.
 */

const listeners = new Set<() => void>();

export function onCheckoutChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyCheckoutChange(): void {
  for (const listener of [...listeners]) listener();
}
