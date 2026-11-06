import type { Prefs } from '../../shared/bridge';

export type ThemePref = Prefs['theme'];

export const THEME_CHOICES: ReadonlyArray<{ value: ThemePref; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

const listeners = new Set<(theme: ThemePref) => void>();

/**
 * Saves the theme through main, which sets nativeTheme and so the page's
 * prefers-color-scheme: every window repaints at once. The palette and the
 * Settings control both come through here, so each hears the other's change.
 */
export async function setThemePref(theme: ThemePref): Promise<void> {
  const prefs = await window.ordewell.prefs.set('theme', theme);
  for (const listener of listeners) listener(prefs.theme);
}

export function onThemePref(listener: (theme: ThemePref) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
