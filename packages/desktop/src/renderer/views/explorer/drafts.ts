/**
 * Edits not yet saved, kept per tab. The frame draws only the active tab, so a
 * file tab unmounts when the user looks at another one; without this the edits
 * would go with it. A draft lives until it is saved, reverted or the window closes.
 */
export interface Draft {
  text: string;
  /** The hash the text was edited from: the save's `baseHash`, so a file changed meanwhile is still caught. */
  baseHash: string | null;
}

const drafts = new Map<string, Draft>();

export const getDraft = (key: string): Draft | undefined => drafts.get(key);
export const setDraft = (key: string, draft: Draft): void => { drafts.set(key, draft); };
export const clearDraft = (key: string): void => { drafts.delete(key); };
export const hasDraft = (key: string): boolean => drafts.has(key);

/** A tab title with the unsaved mark the frame has no field for. */
export const DIRTY_MARK = '● ';
export const withDirtyMark = (title: string, dirty: boolean): string => (dirty ? `${DIRTY_MARK}${stripDirtyMark(title)}` : stripDirtyMark(title));
export const stripDirtyMark = (title: string): string => (title.startsWith(DIRTY_MARK) ? title.slice(DIRTY_MARK.length) : title);
