import { useEffect, useRef } from 'react';
import type { DaemonHost } from '../../session/DaemonHost';
import { settleReveal, useRevealRequest } from '../../session/selection';
import { ChatSurface } from '../../session/useSession';

/** How many frames a reveal waits for its card: a drawer opened for it mounts the list, and the plan arrives after. */
const REVEAL_FRAMES = 30;

/**
 * The plan as a list (W3): the chat's own cards, drawn without its
 * conversation, so every row action is the one the extension offers and
 * answers the same way. A task revealed from elsewhere (the graph, Needs you,
 * Changes) is scrolled to once its card has opened.
 */
export function PlanList({ host }: { host: DaemonHost }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const reveal = useRevealRequest(host);
  useEffect(() => {
    if (!reveal) return undefined;
    let frame = 0;
    let tries = 0;
    const seek = (): void => {
      const card = [...root.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []]
        .find((el) => el.dataset.taskId === reveal.taskId);
      // An opening card grows: scrolling before its body is drawn would leave that body below the fold.
      const ready = card && (card.querySelector('.task-card-body') || tries >= REVEAL_FRAMES);
      if (card && ready) {
        const scroller = card.closest('.frame-plan-body');
        card.scrollIntoView({ block: scroller && card.offsetHeight > scroller.clientHeight ? 'start' : 'nearest' });
        settleReveal(host, reveal.serial);
        return;
      }
      if (tries++ < REVEAL_FRAMES) frame = requestAnimationFrame(seek);
      else settleReveal(host, reveal.serial);
    };
    seek();
    return () => cancelAnimationFrame(frame);
  }, [host, reveal]);
  return (
    // Drawn as if absent, so the chat keeps its place in the panel's column.
    <div ref={root} className="plan-list-host" style={{ display: 'contents' }}>
      <ChatSurface host={host} layout="plan" />
    </div>
  );
}
