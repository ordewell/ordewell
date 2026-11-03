/** "A, B or C" — the runners the host reports, for text that would otherwise list them by hand. */
export function orNames(names: string[], fallback = ''): string {
  if (names.length === 0) return fallback;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
