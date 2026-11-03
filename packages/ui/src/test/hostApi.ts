import { vi } from 'vitest';

/**
 * What the surface under test sent its host and kept across a reload. One per
 * test file, as vitest gives each file its own modules; a test clears it.
 */
export const hostApi = { post: vi.fn(), getState: vi.fn(), setState: vi.fn() };

/**
 * The bridge a test mounts a surface in. Messages from the host arrive as
 * window `message` events, as a webview receives them, so a test drives the
 * surface by dispatching one.
 */
export function testBridge<Out, In>() {
  return {
    post: (message: Out) => hostApi.post(message),
    subscribe: (listener: (message: In) => void) => {
      const receive = (event: MessageEvent<In>) => listener(event.data);
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    },
    getState: () => hostApi.getState(),
    setState: (state: unknown) => hostApi.setState(state),
  };
}
