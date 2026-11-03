import type { HostBridge } from '@ordewell/ui';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/** VS Code throws on a second `acquireVsCodeApi()` in one webview, so every bridge shares the one handle. */
function vscodeApi(): VsCodeApi {
  return (api ??= acquireVsCodeApi());
}

/**
 * A surface's HostBridge in a VS Code webview: posts go through the webview
 * API, and the host's messages arrive as window `message` events.
 */
export function vscodeBridge<Out, In>(): HostBridge<Out, In> {
  return {
    post: (message) => vscodeApi().postMessage(message),
    subscribe(listener) {
      const onMessage = (event: MessageEvent): void => listener(event.data as In);
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    },
    getState: () => vscodeApi().getState(),
    setState: (state) => vscodeApi().setState(state),
  };
}
