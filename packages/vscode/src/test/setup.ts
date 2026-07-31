import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

// The chat webview reads the VS Code bridge at module load; stub it so components
// that import App (or call postMessage) can mount under jsdom. The singleton is
// exposed as __vscodeApi so tests can assert on postMessage calls.
const vscodeApiMock = {
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
};
(globalThis as unknown as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => vscodeApiMock;
(globalThis as unknown as { __vscodeApi?: unknown }).__vscodeApi = vscodeApiMock;

// jsdom doesn't implement scrollIntoView, which ResearchStream calls on update.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// setupFiles run for every test environment; only run DOM cleanup when a
// document exists (jsdom-backed .test.tsx files), not for node-env adapter tests.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});
