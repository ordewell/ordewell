import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The empty composer's tip is the textarea's placeholder (#137), so its colour
 * is the theme's placeholder colour and typed text keeps the input's own.
 * Checked as text, since jsdom resolves no theme.
 */
const css = readFileSync(fileURLToPath(new URL('../../../styles.css', import.meta.url)), 'utf8');

describe('the composer placeholder colour', () => {
  it('follows the host theme placeholder token', () => {
    expect(css).toMatch(/\.chat-input-inner textarea::placeholder\s*\{[^}]*color:\s*var\(--text-placeholder\)/);
    expect(css).toMatch(/--text-placeholder:\s*var\(--ow-fg-placeholder/);
  });
});
