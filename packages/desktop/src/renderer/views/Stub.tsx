import type { Unregister } from '../frame/api';

/**
 * What an empty view shows until its slice draws it. The slice number is
 * docs/desktop/design.md's (Slices), so the owner of each stub is findable.
 */
export function Stub({ what, slice }: { what: string; slice: number }): JSX.Element {
  return <p className="frame-empty" data-stub-slice={slice}>{what} is not built yet.</p>;
}

/** One undo for several registrations. */
export function all(...undo: Unregister[]): Unregister {
  return () => { for (const off of undo) off(); };
}
