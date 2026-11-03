import { fileTabId } from '../explorer/fileTabs';

/*
 * A checkout diff tab's id names the file and which pair of trees it shows:
 * the index against the working tree, or HEAD against the index. The diff tab
 * kind is shared with the run review, so the scope and this prefix decide
 * which reader draws it.
 */

export type CheckoutDiffKind = 'staged' | 'unstaged';

const SEPARATOR = ':';

export function checkoutDiffTabId(repo: string, path: string, kind: CheckoutDiffKind): string {
  return `${kind}${SEPARATOR}${fileTabId(repo, path)}`;
}

export function parseCheckoutDiffTabId(id: string): { repo: string; path: string; kind: CheckoutDiffKind } | undefined {
  const at = id.indexOf(SEPARATOR);
  if (at < 0) return undefined;
  const kind = id.slice(0, at);
  if (kind !== 'staged' && kind !== 'unstaged') return undefined;
  const file = id.slice(at + SEPARATOR.length);
  const split = file.indexOf('//');
  return split < 0
    ? { repo: '.', path: file, kind }
    : { repo: file.slice(0, split), path: file.slice(split + 2), kind };
}

export function checkoutDiffTitle(path: string, kind: CheckoutDiffKind): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  return `${name} (${kind === 'staged' ? 'Staged' : 'Changes'})`;
}
