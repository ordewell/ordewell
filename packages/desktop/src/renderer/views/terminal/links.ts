/**
 * The http(s) addresses on one line of terminal output. Pure so a test can feed
 * it lines; the xterm wrapper turns the matches into clickable ranges.
 */

export interface LinkMatch {
  /** Zero-based offsets into the line: `start` inclusive, `end` exclusive. */
  start: number;
  end: number;
  url: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\^{}|]+/g;
/** What ends a sentence, or closes a bracket around an address, is not part of it. */
const TRAILING = /[.,;:!?'")\]>]+$/;

export function findLinks(line: string): LinkMatch[] {
  const matches: LinkMatch[] = [];
  for (const found of line.matchAll(URL_PATTERN)) {
    let url = found[0];
    url = url.replace(TRAILING, '');
    // A ")" belongs to the address when it closes a "(" inside it, as in a wiki URL.
    if (found[0].slice(url.length).startsWith(')') && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) url += ')';
    if (url.length <= 'https://'.length - 1 || !/^https?:\/\/[^/]/.test(url)) continue;
    const start = found.index ?? 0;
    matches.push({ start, end: start + url.length, url });
  }
  return matches;
}
