import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createServer, request as plainRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { request as tlsRequest } from 'https';
import type { AddressInfo } from 'net';

/** One model API, as a gateway stands in front of it and a broker holds its key. */
export interface ModelApi {
  /** The variable that holds its key, and the one that names another address for it. */
  keyVariable: string;
  baseUrlVariable: string;
  upstream: string;
  /** Model traffic, and nothing else a key can do at this API. */
  paths: RegExp;
  /** The header its key travels in; a runner's token comes the same way. */
  auth: 'x-api-key' | 'bearer';
  /** What a base URL of this API already ends in, so the path a runner asks under does not repeat it. */
  basePath: string;
  /** What a person is told it is. */
  name: string;
  /** Its runner reaches a model by this key and in no other way, so cloud credentials are no login for it. */
  keyOnly: boolean;
}

export const ANTHROPIC_API: ModelApi = {
  keyVariable: 'ANTHROPIC_API_KEY',
  baseUrlVariable: 'ANTHROPIC_BASE_URL',
  upstream: 'https://api.anthropic.com',
  paths: /^\/v1\/(messages|models)(\/|$)/,
  auth: 'x-api-key',
  basePath: '',
  name: 'the Anthropic API',
  keyOnly: false,
};

export const OPENAI_API: ModelApi = {
  keyVariable: 'OPENAI_API_KEY',
  baseUrlVariable: 'OPENAI_BASE_URL',
  upstream: 'https://api.openai.com/v1',
  paths: /^\/v1\/(responses|models)(\/|$)/,
  auth: 'bearer',
  basePath: '/v1',
  name: 'the OpenAI API',
  keyOnly: true,
};

export const MODEL_APIS: readonly ModelApi[] = [ANTHROPIC_API, OPENAI_API];

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
  /** Which API that is. Absent, Anthropic's. */
  api?: ModelApi;
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
  private readonly api: ModelApi;

  constructor(private readonly options: ModelGatewayOptions) {
    this.api = options.api ?? ANTHROPIC_API;
  }

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

  private carries({ headers }: IncomingMessage): boolean {
    const given = this.api.auth === 'bearer' ? headers.authorization?.replace(/^Bearer /i, '') : headers['x-api-key'];
    return typeof given === 'string' && timingSafeEqual(digest(given), digest(this.token));
  }

  private keyHeader(): Record<string, string> {
    return this.api.auth === 'bearer' ? { authorization: `Bearer ${this.options.key}` } : { 'x-api-key': this.options.key };
  }

  private carry(req: IncomingMessage, res: ServerResponse): void {
    if (req.headers.host !== this.host) return this.refuse(res, 403, 'This gateway answers only on its own address.');
    if (!this.carries(req)) return this.refuse(res, 401, "This gateway takes its lease's token, and no other key.");
    const asked = new URL(req.url ?? '/', 'http://gateway');
    if (!MODEL_METHODS.has(req.method ?? '') || !this.api.paths.test(asked.pathname)) return this.refuse(res, 404, 'This gateway carries model traffic and nothing else.');
    const target = new URL(this.options.upstream);
    const send = target.protocol === 'https:' ? tlsRequest : plainRequest;
    const out = send({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname.replace(/\/$/, '')}${asked.pathname.slice(this.api.basePath.length)}${asked.search}`,
      headers: { ...forwarded(req.headers), host: target.host, ...this.keyHeader() },
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
