import { lookup } from 'node:dns/promises';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { IApproval } from '../interfaces/IApproval';
import type { ToolOutcome } from '../interfaces/IFileSystem';

/**
 * The concrete `fetch`/`web_search` implementation, in core so the web server
 * and the VS Code extension share one behavior. Until now `IWebFetcher` had no
 * implementation anywhere, which meant the `fetch` tool was declared to every
 * planner and always answered "not available in this environment" — a tool the
 * model could see, choose, and never use.
 *
 * Approval is per origin, not per URL: reading three pages of one library's
 * docs is one decision, not three.
 */

export interface HttpWebFetcherOptions {
  approval: IApproval;
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  maxChars?: number;
  timeoutMs?: number;
  /** Override the SSRF / private-host guard in tests. */
  isBlockedHost?: (host: string, port: string) => Promise<boolean>;
  /** Override DNS resolution in tests. */
  resolveHost?: (host: string) => Promise<string[]>;
}

const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
/** A default UA gets refused by enough sites that it is not worth the confusing failures. */
const USER_AGENT = 'Mozilla/5.0 (compatible; Ordewell-Planner/1.0; +https://github.com/ordewell)';

/**
 * DuckDuckGo's lite endpoint: no API key, no account, and stable enough for
 * "find me the docs URL". It is HTML scraping, so it is the most brittle thing
 * here by construction — every failure path degrades to a tool result that
 * tells the planner to fall back to `fetch` with a known URL.
 */
const SEARCH_ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

interface SearchHit { title: string; url: string; snippet?: string }

/** Pull result links out of the lite endpoint's markup. */
function parseSearchHits(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkPattern = /<a\b[^>]*class="[^"]*result(?:-link|__a)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="[^"]*result(?:-snippet|__snippet)[^"]*"[^>]*>([\s\S]*?)</gi;

  const snippets: string[] = [];
  for (let m = snippetPattern.exec(html); m; m = snippetPattern.exec(html)) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  }

  for (let m = linkPattern.exec(html); m; m = linkPattern.exec(html)) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    hits.push({ title, url: decodeEntities(m[1]), snippet: snippets[hits.length] });
  }
  return hits;
}

/**
 * Reject hosts that resolve to (or literally name) loopback, link-local, or
 * RFC1918 private space — the SSRF surface. `fetch` is the one capability that
 * leaves the machine, so an unguarded `http://169.254.169.254/` would hand a
 * prompt-injected planner the cloud metadata credentials.
 */
function isPrivateIp(ip: string): boolean {
  // `dns.lookup('')` resolves rather than rejecting, with `address: null` —
  // fail closed instead of letting a falsy/non-string address slip past every
  // regex below untested.
  if (!ip) return true;
  if (ip === '0.0.0.0' || ip === '::' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  // 172.16.0.0/12 = 172.16.0.0 – 172.31.255.255
  const m172 = /^172\.(\d+)\./.exec(ip);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  // fe80::/10 link-local IPv6
  if (/^fe[89ab][0-9a-f]/i.test(ip)) return true;
  return false;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[?[0-9a-fA-F:]+\]?$/i.test(host);
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return 'timed out';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return 'host not reachable';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'host not found';
  return msg.replace(/https?:\/\/\S+/g, '<url>');
}

export class HttpWebFetcher implements IWebFetcher {
  private readonly approval: IApproval;
  private readonly fetchImpl: typeof fetch;
  private readonly maxChars: number;
  private readonly timeoutMs: number;
  private readonly isBlockedHost: (host: string, port: string) => Promise<boolean>;
  private readonly resolveHost: (host: string) => Promise<string[]>;

  constructor(opts: HttpWebFetcherOptions) {
    this.approval = opts.approval;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.isBlockedHost = opts.isBlockedHost ?? this.defaultIsBlocked.bind(this);
    this.resolveHost = opts.resolveHost ?? (async (h) => { const r = await lookup(h); return [r.address]; });
  }

  private async defaultIsBlocked(host: string, port: string): Promise<boolean> {
    if (!['', '80', '443'].includes(port)) return true;
    if (isIpLiteral(host)) return isPrivateIp(host.startsWith('[') ? host.slice(1, -1) : host);
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower === 'ip6-localhost' || lower === 'ip6-loopback') return true;
    try {
      const addrs = await this.resolveHost(host);
      if (addrs.some((a) => isPrivateIp(a))) return true;
    } catch {
      return true;
    }
    return false;
  }

  async confirm(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    // Only the two network schemes. `file:` would turn this into a second,
    // unconfined path reader that bypasses the filesystem's confinement.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    if (await this.isBlockedHost(parsed.hostname, parsed.port)) return false;

    return this.approval.request({
      kind: 'url_fetch',
      subject: url,
      scope: `${parsed.origin}/*`,
      detail: `Planner research wants to fetch ${parsed.origin}`,
    });
  }

  async fetch(url: string): Promise<ToolOutcome> {
    // Gate on the same confirm search uses, so the SSRF guard and the
    // per-origin approval both run even when a caller invokes fetch directly
    // rather than through executeTool.
    if (!await this.confirm(url)) {
      return { success: false, output: `Fetch denied (blocked host or not approved): ${url}`, truncated: false };
    }
    return this.get(url, 'Fetch');
  }

  async search(query: string): Promise<ToolOutcome> {
    const url = SEARCH_ENDPOINT + encodeURIComponent(query);
    if (!await this.confirm(url)) {
      return { success: false, output: `Web search denied by user for query: ${query}`, truncated: false };
    }

    const page = await this.request(url);
    if (!page.ok) return { success: false, output: `Web search failed: ${page.error}`, truncated: false };

    const hits = parseSearchHits(page.body).slice(0, 10);
    if (hits.length === 0) {
      return {
        success: false,
        output: `No results could be parsed for "${query}". Search is best-effort; if you already know a documentation URL, use the fetch tool directly.`,
        truncated: false,
      };
    }

    const output = hits
      .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`)
      .join('\n\n');
    return { success: true, output, truncated: false };
  }

  private async get(url: string, label: string): Promise<ToolOutcome> {
    const page = await this.request(url);
    if (!page.ok) return { success: false, output: `${label} failed: ${page.error}`, truncated: false };

    const text = page.isHtml ? htmlToText(page.body) : page.body;
    if (page.truncated || text.length > this.maxChars) {
      const sliced = text.slice(0, this.maxChars);
      return {
        success: true,
        output: `${sliced}\n\n[... truncated to ${this.maxChars} chars, total ${text.length}${page.truncated ? '+, body was byte-capped at the source' : ''}]`,
        truncated: true,
      };
    }
    return { success: true, output: text, truncated: false };
  }

  private async request(url: string): Promise<{ ok: true; body: string; isHtml: boolean; truncated: boolean } | { ok: false; error: string }> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(current, {
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
          redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) return { ok: false, error: `redirect (${res.status}) with no Location` };
          const next = new URL(location, current).href;
          // Re-check the destination the same way `confirm` checked the origin:
          // a redirect to a private IP, or to a non-http(s) scheme like
          // `file:`, would otherwise bypass both guards `confirm` applies to
          // the initial URL.
          const nextParsed = new URL(next);
          if (nextParsed.protocol !== 'https:' && nextParsed.protocol !== 'http:') {
            return { ok: false, error: 'redirect to a non-HTTP scheme' };
          }
          if (await this.isBlockedHost(nextParsed.hostname, nextParsed.port)) {
            return { ok: false, error: 'redirect to a blocked host' };
          }
          current = next;
          continue;
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const contentType = res.headers.get('content-type') ?? '';
        const { body, truncated } = await readBounded(res, MAX_BODY_BYTES);
        return { ok: true, body, isHtml: /html|xml/i.test(contentType), truncated };
      } catch (err) {
        return { ok: false, error: sanitizeError(err) };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})` };
  }
}

async function readBounded(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const reader = res.body?.[Symbol.asyncIterator]
    ? readFromIterable(res.body as unknown as AsyncIterable<Uint8Array>, maxBytes)
    : readFromText(res, maxBytes);
  return reader;
}

async function readFromIterable(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function readFromText(res: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { body: text, truncated: false };
  return { body: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}
