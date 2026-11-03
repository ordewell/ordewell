import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// jsdom doesn't implement scrollIntoView, which ResearchStream calls on update.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// setupFiles run for every test environment; only run DOM cleanup when a
// document exists (jsdom-backed .test.tsx files), not for node-env tests.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});
