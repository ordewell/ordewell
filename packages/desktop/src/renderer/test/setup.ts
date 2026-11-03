import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// setupFiles run for node tests too; only a DOM test has anything to clean up.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});

// jsdom draws no layout, so the chat's scroll-to-latest has nothing to call.
if (typeof Element !== 'undefined') Element.prototype.scrollIntoView ??= () => {};
