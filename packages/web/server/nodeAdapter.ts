import type { IncomingMessage, ServerResponse } from 'http';
import type { Hono } from 'hono';

/**
 * Bridges node's http server onto the Hono app. Kept out of `main.ts` so the
 * real request path — including the Host header the admission check reads — is
 * testable against a listening server.
 */
export function createRequestListener(app: Hono) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const bufs: Buffer[] = [];
    for await (const chunk of req) bufs.push(chunk as Buffer);
    const body = bufs.length > 0 ? Buffer.concat(bufs).toString() : undefined;

    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) {
        if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
        else headers.set(k, v as string);
      }
    }
    if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const webReq = new Request(url, {
      method: req.method || 'GET',
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });

    try {
      const webRes = await app.fetch(webReq);
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      if (webRes.body) {
        const reader = webRes.body.getReader();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? (err as Error).message : 'Internal server error' }));
      }
    }
  };
}
