import type { OrdewellBridge } from '../shared/bridge';

declare global {
  interface Window {
    /** The preload's bridge (ADR-0060 H4): the page's only way out. */
    readonly ordewell: OrdewellBridge;
  }
}

export {};
