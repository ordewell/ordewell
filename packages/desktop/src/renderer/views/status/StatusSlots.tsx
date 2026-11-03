import type { FrameApi, Unregister } from '../../frame/api';

/**
 * The status bar's lease, runners and usage. Each slot is registered empty: a
 * stub would be noise in a bar this small. Design slice 9 owns this file and
 * fills the three `render`s.
 */
export function register(api: FrameApi): Unregister {
  const offs = (['status.lease', 'status.runners', 'status.usage'] as const).map((slot) =>
    api.registerSlot({ slot, id: slot, render: () => null }));
  return () => { for (const off of offs) off(); };
}
