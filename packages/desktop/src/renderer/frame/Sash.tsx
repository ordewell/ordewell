import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { paneBounds, paneSizes, widthLimit, type Pane } from './layout';
import { useFrameState, useFrameStore } from './store';

const STEP = 16;

interface SashProps {
  pane: Pane;
  label: string;
  /** Which way a drag grows the pane: a left sidebar grows rightwards, the plan panel leftwards, the terminal upwards. */
  grows: 'right' | 'left' | 'up';
}

/**
 * The line between two panes, dragged or moved with the arrow keys. A
 * separator in ARIA terms, so a screen reader reads its value and bounds; its
 * top bound is what leaves the centre its minimum, not only the pane's own.
 */
export function Sash({ pane, label, grows }: SashProps): JSX.Element {
  const store = useFrameStore();
  const { layout } = useFrameState();
  const size = paneSizes(layout)[pane];
  const { min, max: own } = paneBounds(pane, layout.viewport);
  const max = pane === 'terminal' ? own : widthLimit(layout, pane);
  const drag = useRef<{ start: number; size: number }>();
  const vertical = grows !== 'up';
  const sign = grows === 'left' || grows === 'up' ? -1 : 1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { start: vertical ? event.clientX : event.clientY, size };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return;
    const delta = (vertical ? event.clientX : event.clientY) - drag.current.start;
    store.dispatch({ type: 'resize', pane, size: drag.current.size + sign * delta });
  };
  const onPointerUp = (): void => {
    if (!drag.current) return;
    drag.current = undefined;
    store.commitLayout();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const grow: Record<string, number> = vertical ? { ArrowRight: sign, ArrowLeft: -sign } : { ArrowUp: 1, ArrowDown: -1 };
    const step = grow[event.key];
    const to = step !== undefined ? size + step * STEP : event.key === 'Home' ? min : event.key === 'End' ? max : undefined;
    if (to === undefined) return;
    event.preventDefault();
    store.dispatch({ type: 'resize', pane, size: to });
    store.commitLayout();
  };

  return (
    <div
      className={`frame-sash frame-sash-${vertical ? 'vertical' : 'horizontal'}`}
      role="separator"
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
