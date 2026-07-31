import { describe, it, expect, vi } from 'vitest';
import { HttpWebFetcher } from '../HttpWebFetcher';
import type { IApproval } from '../../interfaces/IApproval';

const allow: IApproval = { request: async () => true };
const deny: IApproval = { request: async () => false };

function response(body: string, init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}) {
  const h: Record<string, string> = { 'content-type': init.contentType ?? 'text/html', ...(init.headers ?? {}) };
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (name: string) => h[name.toLowerCase()] ?? null },
    text: async () => body,
    body: null,
  } as unknown as Response;
}

// Real DNS is slow and flaky in CI. We inject `resolveHost` so the default
// blocklist never hits the network; IP literals and `localhost` are caught
// before any lookup, so SSRF cases still exercise the real guard.
function makeFetcher(opts: ConstructorParameters<typeof HttpWebFetcher>[0]) {
  return new HttpWebFetcher({ resolveHost: async () => [], ...opts });
}

describe('HttpWebFetcher.confirm', () => {
  it('asks per origin, so a second page on the same host does not re-prompt', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const fetcher = makeFetcher({ approval: { request } });

    await fetcher.confirm('https://docs.rs/tokio/latest/tokio/');

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'url_fetch',
      subject: 'https://docs.rs/tokio/latest/tokio/',
      scope: 'https://docs.rs/*',
    }));
  });

  it('refuses a non-HTTP scheme without consulting the user', async () => {
    const request = vi.fn();
    const fetcher = makeFetcher({ approval: { request } });

    expect(await fetcher.confirm('file:///etc/passwd')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a malformed URL rather than throwing mid-turn', async () => {
    const fetcher = makeFetcher({ approval: allow });
    expect(await fetcher.confirm('not a url')).toBe(false);
  });
});

describe('HttpWebFetcher.fetch', () => {
  it('returns readable text with the markup stripped', async () => {
    const html = '<html><head><style>a{}</style></head><body><h1>Tokio</h1><p>An async runtime.</p></body></html>';
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response(html) });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(true);
    expect(result.output).toContain('Tokio');
    expect(result.output).toContain('An async runtime.');
    expect(result.output).not.toContain('<h1>');
    expect(result.output).not.toContain('a{}');
  });

  it('leaves non-HTML content alone', async () => {
    const json = '{"name":"tokio"}';
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response(json, { contentType: 'application/json' }) });

    const result = await fetcher.fetch('https://registry.example/tokio');

    expect(result.output).toBe(json);
  });

  it('reports an HTTP error as a failed tool result rather than throwing', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response('nope', { status: 404 }) });

    const result = await fetcher.fetch('https://docs.rs/missing');

    expect(result.success).toBe(false);
    expect(result.output).toContain('404');
  });

  it('reports a network failure as a failed tool result', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(false);
    expect(result.output).toContain('host not reachable');
  });

  it('caps a huge page and says it did', async () => {
    const fetcher = makeFetcher({
      approval: allow,
      maxChars: 50,
      fetchImpl: async () => response(`<p>${'x'.repeat(500)}</p>`),
    });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.truncated).toBe(true);
    expect(result.output).toContain('truncated');
  });
});

describe('HttpWebFetcher.search', () => {
  const RESULTS = `
    <html><body>
      <a class="result__a" href="https://hono.dev/docs/routing">Hono Routing</a>
      <a class="result__snippet">Define routes with app.get.</a>
      <a class="result__a" href="https://github.com/honojs/hono">honojs/hono</a>
    </body></html>`;

  it('returns numbered titles with their URLs', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response(RESULTS) });

    const result = await fetcher.search('hono routing');

    expect(result.success).toBe(true);
    expect(result.output).toContain('Hono Routing');
    expect(result.output).toContain('https://hono.dev/docs/routing');
    expect(result.output).toContain('honojs/hono');
  });

  it('tells the planner what to do when the search returns nothing usable', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => response('<html><body>nothing</body></html>') });

    const result = await fetcher.search('zzz');

    expect(result.success).toBe(false);
    expect(result.output).toContain('No results');
  });

  it('reports a network failure without failing the turn', async () => {
    const fetcher = makeFetcher({ approval: allow, fetchImpl: async () => { throw new Error('offline'); } });

    const result = await fetcher.search('hono');

    expect(result.success).toBe(false);
    expect(result.output).toContain('offline');
  });

  it('asks for approval once for the search engine itself', async () => {
    const request = vi.fn().mockResolvedValue(true);
    const fetcher = makeFetcher({ approval: { request }, fetchImpl: async () => response(RESULTS) });

    await fetcher.search('hono');
    await fetcher.search('zod');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toMatchObject({ kind: 'url_fetch' });
  });

  it('does not search when approval is refused', async () => {
    const fetchImpl = vi.fn();
    const fetcher = makeFetcher({ approval: deny, fetchImpl });

    const result = await fetcher.search('hono');

    expect(result.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// fetch is the one capability that leaves the machine, so an unguarded
// http://169.254.169.254/ would hand a prompt-injected planner the cloud
// metadata credentials. The blocklist runs before approval is even asked.
describe('HttpWebFetcher SSRF guard', () => {
  it.each([
    ['http://127.0.0.1/', 'loopback IPv4'],
    ['http://localhost/', 'localhost'],
    ['http://0.0.0.0/', '0.0.0.0'],
    ['http://[::1]/', 'loopback IPv6'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://192.168.1.1/', 'RFC1918 192.168'],
    ['http://10.0.0.1/', 'RFC1918 10'],
    ['http://172.16.0.1/', 'RFC1918 172.16/12'],
  ])('refuses %s without consulting the approval channel', async (url) => {
    const request = vi.fn().mockResolvedValue(true);
    const fetchImpl = vi.fn();
    const fetcher = makeFetcher({ approval: { request }, fetchImpl });

    expect(await fetcher.confirm(url)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    // A direct fetch must also fail rather than reach the network.
    const result = await fetcher.fetch(url);
    expect(result.success).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTP(S) port', async () => {
    const request = vi.fn();
    const fetcher = makeFetcher({ approval: { request } });
    expect(await fetcher.confirm('https://internal.example:6379/')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('HttpWebFetcher redirect handling', () => {
  // A 302 to a private IP would bypass confirm's origin check — the classic
  // SSRF-via-redirect — so each hop is re-checked against the blocklist.
  it('refuses a redirect to a blocked host even when the origin was approved', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://api.example.com/x') {
        return response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      return response('ok');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://api.example.com/x');

    expect(result.success).toBe(false);
    expect(result.output).toContain('blocked host');
  });

  it('follows a same-origin redirect to a public host', async () => {
    let first = true;
    const fetchImpl = vi.fn().mockImplementation(() => {
      if (first) { first = false; return response('', { status: 301, headers: { location: 'https://docs.rs/tokio/' } }); }
      return response('<p>page</p>');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(true);
    expect(result.output).toContain('page');
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => response('', { status: 302, headers: { location: 'https://docs.rs/loop' } }));
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/redirect/i);
  });

  // confirm() rejects non-HTTP schemes up front, but a redirect hop only ever
  // re-checked the host blocklist — a 302 to `file:///etc/passwd` skipped the
  // scheme check entirely and would have been followed.
  it('refuses a redirect to a non-HTTP scheme', async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url === 'https://api.example.com/x') {
        return response('', { status: 302, headers: { location: 'file:///etc/passwd' } });
      }
      return response('ok');
    });
    const fetcher = makeFetcher({ approval: allow, fetchImpl });

    const result = await fetcher.fetch('https://api.example.com/x');

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/scheme/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HttpWebFetcher isBlockedHost null-address guard', () => {
  // dns.lookup('') resolves rather than rejecting, with address: null (Node
  // treats an empty hostname as loopback-ish but doesn't throw) — isPrivateIp
  // must fail closed on that instead of every regex quietly missing `null`.
  it('blocks a host that resolves to a null address', async () => {
    const request = vi.fn();
    const fetcher = makeFetcher({ approval: { request }, resolveHost: async () => [null as unknown as string] });

    expect(await fetcher.confirm('https://weird-host.example/')).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('HttpWebFetcher body byte cap', () => {
  it('caps an oversized stream and reports truncation rather than OOMing', async () => {
    // A streaming body larger than the byte ceiling must stop reading and mark
    // the result truncated, mirroring the exec-buffer cap the ADR fixed for
    // search — not buffer the whole thing and crash the planner.
    const huge = 'x'.repeat(2_500_000);
    const stream = (async function* () { yield Buffer.from(huge); })();
    const fetchImpl = vi.fn().mockImplementation(() => ({
      ok: true, status: 200,
      headers: { get: () => 'text/plain' },
      body: stream,
    } as unknown as Response));
    const fetcher = makeFetcher({ approval: allow, fetchImpl, maxChars: 100 });

    const result = await fetcher.fetch('https://docs.rs/tokio');

    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(2000);
  });
});
