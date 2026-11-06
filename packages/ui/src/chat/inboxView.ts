import { useCallback, useRef, useState } from 'react';

/**
 * Whether the chat draws the escalation inbox at all (ADR-0053). The one place
 * to flip the default: `/inbox` turns it off and on from there, and what a user
 * chose is remembered over it.
 */
export const INBOX_VIEW_DEFAULT = true;

/** The inbox starts as its one-line bar: a list of items would take the conversation's room before the user asked. */
export const INBOX_OPEN_DEFAULT = false;

export const INBOX_OFF_NOTE = 'The waiting-on-you list is off here. Type /inbox to turn it back on. The task rows, approval cards and notifications are unchanged.';

export interface InboxPrefs {
  /** The view is drawn. Off, nothing of it is: core's list and every other surface carry on. */
  enabled: boolean;
  /** The list is open rather than its bar alone. */
  open: boolean;
}

/** The webview's saved state, narrowed: anything else it holds, or nothing, leaves the defaults. */
export function readInboxPrefs(saved: unknown): InboxPrefs {
  const inbox = (saved as { inbox?: Partial<Record<keyof InboxPrefs, unknown>> } | null | undefined)?.inbox;
  return {
    enabled: typeof inbox?.enabled === 'boolean' ? inbox.enabled : INBOX_VIEW_DEFAULT,
    open: typeof inbox?.open === 'boolean' ? inbox.open : INBOX_OPEN_DEFAULT,
  };
}

interface StateApi {
  getState(): unknown;
  setState(state: unknown): void;
}

/** The inbox's two choices, kept in the webview's own state so a reload finds them again. */
export function useInboxPrefs(api: StateApi): InboxPrefs & { update(change: Partial<InboxPrefs>): void } {
  const [prefs, setPrefs] = useState(() => readInboxPrefs(api.getState()));
  const current = useRef(prefs);
  const update = useCallback((change: Partial<InboxPrefs>) => {
    const next = { ...current.current, ...change };
    if (next.enabled === current.current.enabled && next.open === current.current.open) return;
    current.current = next;
    const saved = api.getState();
    api.setState({ ...(typeof saved === 'object' && saved !== null ? saved : {}), inbox: next });
    setPrefs(next);
  }, [api]);
  return { ...prefs, update };
}
