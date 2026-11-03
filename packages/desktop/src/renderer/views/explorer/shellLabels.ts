/** What the OS calls its file manager, for the Reveal action's label. */
export function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in File Explorer';
  return 'Show in file manager';
}
