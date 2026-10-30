import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The activity line's motion is CSS-only, so its reduced-motion fallback is read as text. */
const css = readFileSync(fileURLToPath(new URL('../../chat/styles.css', import.meta.url)), 'utf8');

describe('the activity line stylesheet', () => {
  it('reuses the chat spinner and stills it for a reader who asked for less motion', () => {
    expect(css).toMatch(/\.chat-msg-spinner\s*\{[^}]*animation: chat-spin/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.task-log-activity \.chat-msg-spinner\s*\{\s*animation: none;/);
  });
});
