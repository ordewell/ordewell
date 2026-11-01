import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer, request as plainRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { request as tlsRequest } from 'https';
import type { AddressInfo } from 'net';

/** Model traffic, and nothing else a key can do at the API. */
const MODEL_PATH = /^\/v1\/(messages|models)(\/|$)/;
const MODEL_METHODS: ReadonlySet<string> = new Set(['GET', 'POST']);

/** What ends at this hop, what names it, and any credential a client sent, which would be a way out under a key of its own. */
const NOT_FORWARDED: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'x-api-key', 'authorization']);

const forwarded = (headers: IncomingHttpHeaders): IncomingHttpHeaders => Object.fromEntries(Object.entries(headers).filter(([name]) => !NOT_FORWARDED.has(name)));

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

export interface ModelGatewayOptions {
  /** The API key, which stays on this host. */
  key: string;
  /** Where model traffic goes. */
  upstream: string;
}

/**
 * The base-URL gateway of a lease (ADR-0059 L7). It runs on this host and is
 * reached through the relay, so an API key never enters the engine: what a
 * runner holds is {@link token}, which means nothing past this listener. Every
 * request goes to the one upstream under the real key, so a process in the
 * container can spend it on model traffic and cannot read it, send it elsewhere
 * or use the model API under a key of its own. TLS ends here for that one host,
 * which is the only interception a lease does.
 *
 * A listener on this host's loopback answers any local process, so the token
 * and the Host check hold here as they do at the MCP server (ADR-0022 T2).
 */
export class ModelGateway {
  /** What the runner sends in place of the key. */
  readonly token = `ordewell-lease-${randomBytes(24).toString('hex')}`;
  private readonly server: Server = createServer((req, res) => this.carry(req, res));
  private host = '';

  constructor(private readonly options: ModelGatewayOptions) {}

  /** The port it took on this host's loopback. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        this.host = `127.0.0.1:${port}`;
        resolve(port);
      });
    });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); });
  }

  private carries(given: string | string[] | undefined): boolean {
    return typeof given === 'string' && timingSafeEqual(digest(given), digest(this.token));
  }

  private carry(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.host !== this.host) return this.refuse(res, 403, 'This gateway answers only on its own address.');
    if (!this.carries(req.headers['x-api-key'])) return this.refuse(res, 401, "This gateway takes its lease's token, and no other key.");
    const asked = new URL(req.url ?? '/', 'http://gateway');
    if (!MODEL_METHODS.has(req.method ?? '') || !MODEL_PATH.test(asked.pathname)) return this.refuse(res, 404, 'This gateway carries model traffic and nothing else.');
    const target = new URL(this.options.upstream);
    const send = target.protocol === 'https:' ? tlsRequest : plainRequest;
    const out = send({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname.replace(/\/$/, '')}${asked.pathname}${asked.search}`,
      headers: { ...forwarded(req.headers), host: target.host, 'x-api-key': this.options.key },
    }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, forwarded(answer.headers));
      answer.pipe(res);
    });
    // The OS's words for a dead upstream say where it went, so none of them reach the container.
    out.on('error', () => {
      if (res.headersSent) res.destroy();
      else this.refuse(res, 502, 'The model API did not answer.');
    });
    res.once('close', () => out.destroy());
    req.pipe(out);
  }

  private refuse(res: ServerResponse, status: number, why: string): void {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(`${why}\n`);
  }
}
