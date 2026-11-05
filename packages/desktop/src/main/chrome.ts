import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron';

/** The title bar's height; the renderer's frame.css draws its bar at the same height. */
export const TITLE_BAR_HEIGHT = 40;

/** The window's canvas before the page paints, in the design's canvas colours (docs/desktop/design.md). */
export function canvasColour(dark: boolean): string {
  return dark ? '#1c1f23' : '#ffffff';
}

/**
 * The window controls drawn over the page's own title bar on Windows and
 * Linux: the chrome colour, so they sit on the bar rather than over it.
 */
export function titleBarOverlay(dark: boolean): TitleBarOverlayOptions {
  return dark
    ? { color: '#141619', symbolColor: '#e6e8eb', height: TITLE_BAR_HEIGHT }
    : { color: '#f1f2f4', symbolColor: '#1a1c1f', height: TITLE_BAR_HEIGHT };
}

/**
 * A workspace window draws its own title bar and keeps the platform's
 * controls: inset traffic lights on macOS, an overlay elsewhere. The welcome
 * window has nothing to put in a bar, so it keeps the native one.
 */
export function workspaceChrome(platform: NodeJS.Platform, dark: boolean): BrowserWindowConstructorOptions {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } };
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(dark) };
}
