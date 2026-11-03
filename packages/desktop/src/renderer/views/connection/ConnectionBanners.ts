import type { DaemonStatus } from '../../../shared/bridge';
import { cardFor } from '../../DaemonBar';
import type { FrameApi, Unregister } from '../../frame/api';

/**
 * The daemon's state as a banner above the editor (design W15), so a
 * workspace window keeps the card the shell tracer drew. Design slice 9 owns
 * this file and adds the held-session banner (W16) beside it.
 */
export function register(api: FrameApi): Unregister {
  let dismiss: (() => void) | undefined;
  const show = (status: DaemonStatus): void => {
    dismiss?.();
    dismiss = undefined;
    const card = cardFor(status);
    if (!card) return;
    dismiss = api.showBanner({
      id: 'daemon',
      tone: card.tone,
      title: card.title,
      body: card.body,
      actions: card.actions.map(({ action, label }) => ({
        label,
        run: async () => {
          const result = await window.ordewell.daemon[action]();
          if (!result.ok && result.message) api.announce(result.message);
        },
      })),
    });
  };
  let live = true;
  const off = window.ordewell.daemon.onStatus(show);
  void window.ordewell.daemon.status().then((status) => { if (live) show(status); });
  return () => { live = false; off(); dismiss?.(); };
}
