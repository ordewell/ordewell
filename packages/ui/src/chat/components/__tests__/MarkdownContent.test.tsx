import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownContent from '../MarkdownContent';
import { renderMarkdown } from '../ChatMessage';

/*
 * The patched DOM must end up exactly what assigning the HTML would have made,
 * whatever it was before: selection retention is the reason it patches, never
 * a licence to show something else.
 */

const shows = (html: string, then: string) => {
  const { container, rerender } = render(<MarkdownContent html={html} />);
  rerender(<MarkdownContent html={then} />);
  const expected = document.createElement('div');
  expected.innerHTML = then;
  return { actual: container.firstElementChild!.innerHTML, expected: expected.innerHTML };
};

describe('MarkdownContent', () => {
  it.each([
    ['text that grows', '<p>one</p>', '<p>one two</p>'],
    ['text that shrinks or changes in the middle', '<p>alpha beta gamma</p>', '<p>alpha delta gamma</p>'],
    ['an element that becomes another', '<p>x</p>', '<h2>x</h2>'],
    ['blocks added', '<p>a</p>', '<p>a</p><ul><li>b</li></ul>'],
    ['blocks removed', '<p>a</p><p>b</p><p>c</p>', '<p>a</p>'],
    ['a link whose target changes', '<a href="https://a.test/">x</a>', '<a href="https://b.test/" title="t">x</a>'],
    ['an attribute that goes away', '<a href="https://a.test/" title="t">x</a>', '<a href="https://a.test/">x</a>'],
    ['everything gone', '<p>a</p>', ''],
  ])('shows %s as a fresh render would', (_name, before, after) => {
    const { actual, expected } = shows(before, after);

    expect(actual).toBe(expected);
  });

  it('keeps a node that did not change, and extends a text that only grew', () => {
    const { container, rerender } = render(<MarkdownContent html="<p>Run <code>npm test</code> now</p>" />);
    const code = container.querySelector('code')!;
    const tail = code.nextSibling!;

    rerender(<MarkdownContent html="<p>Run <code>npm test</code> now, then push</p>" />);

    expect(container.querySelector('code')).toBe(code);
    expect(code.nextSibling).toBe(tail);
    expect(container.textContent).toBe('Run npm test now, then push');
  });

  it('stays inert and escaped for text the markdown renderer escaped', () => {
    const { container } = render(<MarkdownContent html={renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>')} />);

    expect(container.querySelector('script, img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
