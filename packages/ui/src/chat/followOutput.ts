import { useCallback, useLayoutEffect, useRef } from 'react';

/** How far above the bottom still counts as reading the newest output. */
const PIN_SLACK_PX = 50;

export interface FollowOutputOptions {
  /**
   * Whether this surface follows its newest line right now. A first screen is
   * not a log — it has a hero at its top — so its host turns following off
   * until there is output to follow.
   */
  follow?: boolean;
}

/**
 * Keeps a live log on its newest output while the reader is at the bottom,
 * and leaves it where it is once they scroll up to read back. Every log in the
 * webviews that grows under the reader follows through this one hook.
 *
 * Returns the ref for the element that scrolls. `content` is what, on change,
 * may have added output. A newly attached element starts at its bottom, unless
 * `follow` is off: then it stays where it is, at the top a first screen opens on.
 */
export function useFollowOutput<T extends HTMLElement>(
  content: unknown[],
  { follow = true }: FollowOutputOptions = {},
): (el: T | null) => void {
  const elRef = useRef<T | null>(null);
  const pinnedRef = useRef(true);
  const followRef = useRef(follow);
  // Output arriving after a first screen follows again, whatever the reader
  // did with the screen that came before it.
  if (follow !== followRef.current) {
    followRef.current = follow;
    if (follow) pinnedRef.current = true;
  }
  const detachRef = useRef<(() => void) | null>(null);

  // Instant, never smooth: a smooth scroll fires scroll events mid-animation
  // that read as "scrolled away" when a large block lands, which unpins it.
  const stick = useCallback(() => {
    const el = elRef.current;
    if (el && followRef.current && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const attach = useCallback((el: T | null) => {
    detachRef.current?.();
    detachRef.current = null;
    elRef.current = el;
    if (!el) return;

    pinnedRef.current = true;
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // A disclosure opened at the bottom grows the log below the reader without
    // a scroll event; re-read where they are once it has drawn, so the next
    // output does not carry them past what they opened.
    let disclosed: ReturnType<typeof setTimeout> | undefined;
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('[aria-expanded]')) return;
      clearTimeout(disclosed);
      disclosed = setTimeout(onScroll, 0);
    };
    el.addEventListener('click', onClick);
    // What shares the view with the log (a composer, a dock, a banner) takes
    // height from it without a scroll event, pushing the newest lines out.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick);
    observer?.observe(el);
    detachRef.current = () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('click', onClick);
      clearTimeout(disclosed);
      observer?.disconnect();
    };
    stick();
  }, [stick]);

  useLayoutEffect(stick, content);

  return attach;
}
