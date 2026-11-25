import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

// Every test starts in a window with one folder open; a test that needs none says so.
afterEach(async () => {
  const mock = await import('./vscode.mock');
  try {
    mock.__setWorkspaceFolders([mock.MOCK_WORKSPACE_FOLDER]);
  } catch {
    // The file mocks `vscode` with a factory of its own, which has no folders to reset.
  }
});

// setupFiles run for every test environment; only run DOM cleanup when a
// document exists (jsdom-backed .test.tsx files), not for node-env adapter tests.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});

// The config reads the enabled runners from the user's settings file, which a
// test must never take from the developer's own home directory.
if (process.env.ORDEWELL_SETTINGS_PATH === undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-test-settings-'));
  process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
}
