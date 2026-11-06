import React, { useCallback, useState } from 'react';
import { dragDockHeight } from '../planDock';

const KEY_STEP = 24;

interface DockResizeHandleProps {
  /** The dock's scroll region, the element whose max-height the drag sets. */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** The conversation the dock grows into; its CSS min-height is the floor it keeps. */
  listRef: React.RefObject<HTMLDivElement | null>;
  onCommit(height: number): void;
}

function measure(body: HTMLDivElement, list: HTMLDivElement) {
  const border = body.offsetHeight - body.clientHeight;
  const floor = parseFloat(getComputedStyle(list).minHeight) || 0;
  return {
    start: body.offsetHeight,
    limits: {
      content: body.scrollHeight + border,
      available: body.offsetHeight + list.offsetHeight - floor,
    },
  };
}

/**
 * The dock's top edge. A drag writes max-height straight to the DOM and commits
 * once on release: a state update per pointer move would re-render the whole
 * plan, every task card with it, on every frame.
 */
export default function DockResizeHandle({ bodyRef, listRef, onCommit }: DockResizeHandleProps) {
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    const list = listRef.current;
    if (!body || !list || e.button !== 0) return;
    e.preventDefault();
    // Without capture, a release outside the webview's frame never arrives
    // and the drag would follow the pointer until the next click.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { start, limits } = measure(body, list);
    const startY = e.clientY;
    let height: number | undefined;
    setDragging(true);

    const move = (ev: PointerEvent) => {
      height = dragDockHeight(start + startY - ev.clientY, limits);
      body.style.maxHeight = `${height}px`;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      setDragging(false);
      // A click with no movement would otherwise commit the current rendered
      // height and lower a cap the plan's content simply hadn't reached.
      if (height !== undefined) onCommit(height);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }, [bodyRef, listRef, onCommit]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const body = bodyRef.current;
    const list = listRef.current;
    if (!body || !list) return;
    e.preventDefault();
    const { start, limits } = measure(body, list);
    const height = dragDockHeight(start + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP), limits);
    body.style.maxHeight = `${height}px`;
    onCommit(height);
  }, [bodyRef, listRef, onCommit]);

  return (
    <div
      className={`plan-dock-resize${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the plan"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
