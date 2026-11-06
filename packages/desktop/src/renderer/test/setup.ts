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

// jsdom's window is 1024 wide, narrow enough that the frame folds the sidebar
// into a drawer (layout.ts, fit). A test sees the docked layout of a laptop
// window unless it sizes the window itself.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1512 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 982 });
}
