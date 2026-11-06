import React, { useLayoutEffect, useRef } from 'react';

/*
 * Markdown HTML that updates in place. A streamed reply is re-rendered on every
 * delta, and assigning `innerHTML` (what `dangerouslySetInnerHTML` does) throws
 * away every node, collapsing a selection anchored in any of them. Here the new
 * HTML is parsed inertly and the live DOM is patched toward it, so a node whose
 * content did not change is never touched and a text node that only grew is
 * extended at its end, which leaves a range inside it alone.
 */

/** Make `live` hold `next`'s text by changing only the span between their common prefix and suffix. */
function patchText(live: CharacterData, next: string): void {
  const old = live.data;
  if (old === next) return;
  let start = 0;
  const shortest = Math.min(old.length, next.length);
  while (start < shortest && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < shortest - start && old.charCodeAt(old.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  live.replaceData(start, old.length - start - end, next.slice(start, next.length - end));
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  return a.nodeType !== Node.ELEMENT_NODE || (a as Element).localName === (b as Element).localName;
}

function patchAttributes(live: Element, next: Element): void {
  for (const { name } of Array.from(live.attributes)) {
    if (!next.hasAttribute(name)) live.removeAttribute(name);
  }
  for (const { name, value } of Array.from(next.attributes)) {
    if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  }
}

/** Bring the children of `live` to those of `next`, keeping each live node that can stand for its counterpart. */
function patchChildren(live: Node, next: Node): void {
  const wanted = Array.from(next.childNodes);
  const have = Array.from(live.childNodes);
  wanted.forEach((node, i) => {
    const existing = have[i];
    if (!existing) {
      live.appendChild(node);
    } else if (!sameKind(existing, node)) {
      live.replaceChild(node, existing);
    } else if (existing.nodeType === Node.ELEMENT_NODE) {
      patchAttributes(existing as Element, node as Element);
      patchChildren(existing, node);
    } else if (existing.nodeType === Node.TEXT_NODE || existing.nodeType === Node.COMMENT_NODE) {
      patchText(existing as CharacterData, (node as CharacterData).data);
    }
  });
  for (const stale of have.slice(wanted.length)) live.removeChild(stale);
}

export default function MarkdownContent({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    // A template's content is inert: nothing in it loads or runs until it is adopted.
    const next = document.createElement('template');
    next.innerHTML = html;
    patchChildren(host, next.content);
  }, [html]);
  return <div ref={ref} className={className} />;
}
