/**
 * The one address a terminal link may open: http or https, nothing else. A
 * program in the shell prints whatever it likes, so `file:`, `javascript:` and
 * custom-scheme addresses never reach the OS (the page cannot open a window
 * itself, security.ts).
 */
export function webLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  return url.href;
}
