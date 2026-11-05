import type { ChildProcess } from 'child_process';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'net';
import { LineTail } from '../../utils/lineTail';
import { redactAgentText } from '../../utils/redactSecrets';

/*
 * One frame, either way: its kind, its connection and its length, then that
 * many bytes. READY, LISTENING and OPEN go up from the entry; LISTEN and
 * CONNECT go down to it; OPENED answers a CONNECT; the rest go both ways, for
 * one connection.
 */
const HEADER_BYTES = 9;
const READY = 1;
const OPEN = 2;
const DATA = 3;
const CLOSE = 4;
const LISTEN = 5;
const LISTENING = 6;
const CONNECT = 7;
const OPENED = 8;

/**
 * Where a reverse connection's ids start. The entry allocates a forward one
 * from 1, so the two directions cannot collide while either is under 2^30.
 */
const REVERSE_FIRST = 0x4000_0000;

/** Past any chunk a socket reads. Anything longer is a process in the container writing to the entry's stdout. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** What a start error shows of the entry's stderr, of a larger tail kept whole so redaction reads every line it shows (see LineTail). */
const STDERR_LIMITS = { keepChars: 8000, showChars: 2000 };

/**
 * What a lease's container runs as its one idle process (ADR-0059 L5), handed
 * to `node -e`, so an image needs node and no file of Ordewell's. It listens on
 * the container's own loopback for each port the host asks for and carries every
 * connection over its stdin and stdout. It also dials one there when the host
 * asks, which is how the host reaches a server of the container's: no network
 * either way. Its stdin is what keeps the container: when the host goes, by any
 * death, the pipe closes, this exits and `--rm` takes the container with
 * everything in it, so nothing needs a timer to renew.
 */
export const RELAY_ENTRY = String.raw`
const net = require('net');
const [READY, OPEN, DATA, CLOSE, LISTEN, LISTENING, CONNECT, OPENED] = [1, 2, 3, 4, 5, 6, 7, 8];
const conns = new Map();
let nextConn = 1;
let inbound = Buffer.alloc(0);
const port16 = (port) => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; };
function send(kind, conn, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header[0] = kind;
  header.writeUInt32BE(conn, 1);
  header.writeUInt32BE(payload.length, 5);
  process.stdout.write(Buffer.concat([header, payload]));
}
function listen(port) {
  net.createServer((socket) => {
    const conn = nextConn++;
    conns.set(conn, socket);
    send(OPEN, conn, port16(port));
    socket.on('data', (chunk) => send(DATA, conn, chunk));
    const closed = () => { if (conns.delete(conn)) send(CLOSE, conn); };
    socket.on('close', closed);
    socket.on('error', closed);
  }).listen(port, '127.0.0.1', () => send(LISTENING, 0, port16(port)));
}
function dial(conn, port) {
  const socket = net.connect(port, '127.0.0.1');
  conns.set(conn, socket);
  socket.on('connect', () => send(OPENED, conn));
  socket.on('data', (chunk) => send(DATA, conn, chunk));
  const closed = () => { if (conns.delete(conn)) send(CLOSE, conn); };
  socket.on('close', closed);
  socket.on('error', closed);
}
function frame(kind, conn, payload) {
  if (kind === LISTEN) listen(payload.readUInt16BE(0));
  else if (kind === CONNECT) dial(conn, payload.readUInt16BE(0));
  else if (kind === DATA) conns.get(conn)?.write(payload);
  else if (kind === CLOSE) { const socket = conns.get(conn); conns.delete(conn); socket?.destroy(); }
}
process.stdin.on('data', (chunk) => {
  inbound = Buffer.concat([inbound, chunk]);
  while (inbound.length >= 9) {
    const length = inbound.readUInt32BE(5);
    if (inbound.length < 9 + length) break;
    frame(inbound[0], inbound.readUInt32BE(1), inbound.subarray(9, 9 + length));
    inbound = inbound.subarray(9 + length);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
send(READY, 0);
`;

/**
 * The host's end of {@link RELAY_ENTRY}: how a runner in a container reaches a
 * listener on this host's loopback with no route to it (ADR-0059 L6). No
 * network is involved, so it works on any engine and under any egress, and a
 * container reaches nothing but what was forwarded: a port never forwarded is
 * closed however a frame asks for it. A process in the container can write the
 * entry's stdout, so nothing read here is trusted.
 */
export class LeaseRelay {
  /** Settles once the entry has started, or rejects with why it did not. */
  readonly ready: Promise<void>;
  /** Resolves when the entry has gone, for any reason. */
  readonly ended: Promise<void>;
  private inbound = Buffer.alloc(0);
  private readonly sockets = new Map<number, Socket>();
  private readonly forwards = new Map<number, { hostPort: number; listening: Promise<void>; heard: () => void; failed: (err: Error) => void }>();
  /** This host's listeners, each carrying into the container on the port it was asked for. */
  private readonly exposed = new Set<Server>();
  private readonly waiting = new Set<number>();
  private nextReverse = REVERSE_FIRST;
  private readonly stderrTail = new LineTail(STDERR_LIMITS);
  private markReady!: () => void;
  private failReady!: (err: Error) => void;

  constructor(private readonly entry: ChildProcess) {
    this.ready = new Promise<void>((resolve, reject) => { this.markReady = resolve; this.failReady = reject; });
    // A start that failed is reported to whoever awaits it; a relay nobody awaited has nobody to tell.
    this.ready.catch(() => undefined);
    this.ended = new Promise<void>((resolve) => {
      entry.once('close', () => { this.gone(); resolve(); });
      entry.once('error', (err) => { this.stderrTail.append(err.message); this.gone(); resolve(); });
    });
    entry.stdin?.on('error', () => undefined);
    entry.stderr?.on('data', (chunk: Buffer) => this.stderrTail.append(chunk.toString()));
    entry.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
  }

  /**
   * What the entry last wrote to stderr: the one explanation a container that
   * would not start leaves, and runner text on its way to the task's error and
   * the planner, so redacted as such.
   */
  get lastWords(): string { return this.stderrTail.read(redactAgentText); }

  /**
   * Have the container's loopback answer on `containerPort` with this host's on
   * `hostPort`. Idempotent: an attempt's respawn asks again for the same port.
   */
  forward(containerPort: number, hostPort: number): Promise<void> {
    const known = this.forwards.get(containerPort);
    if (known) return known.listening;
    let heard!: () => void;
    let failed!: (err: Error) => void;
    const listening = new Promise<void>((resolve, reject) => { heard = resolve; failed = reject; });
    this.forwards.set(containerPort, { hostPort, listening, heard, failed });
    const port = Buffer.alloc(2);
    port.writeUInt16BE(containerPort);
    this.send(LISTEN, 0, port);
    return listening;
  }

  /**
   * Have a listener on this host's loopback carry into the container's
   * `containerPort`, and answer the port it took here. What a runner's own
   * server listens on inside is reached this way, as the MCP server is by
   * {@link forward} the other way. Nothing is routed: the bytes cross the
   * relay's pipes, so any engine and any egress carry them. A process in the
   * container can write the entry's stdout, so only an OPENED for a connection
   * this host opened is believed.
   */
  async expose(containerPort: number): Promise<number> {
    const server = createServer((socket) => {
      const conn = this.nextReverse++;
      this.sockets.set(conn, socket);
      this.waiting.add(conn);
      // Paused until the entry says it dialled: what the client sends waits in
      // its socket rather than in this process, and a container that never
      // dials never takes it.
      socket.pause();
      const closed = () => {
        this.waiting.delete(conn);
        if (this.sockets.delete(conn)) this.send(CLOSE, conn);
      };
      socket.on('close', closed);
      socket.on('error', closed);
      const port = Buffer.alloc(2);
      port.writeUInt16BE(containerPort);
      this.send(CONNECT, conn, port);
    });
    this.exposed.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  /** The entry dialled a connection this host opened: from here its bytes are the client's. */
  private opened(conn: number): void {
    if (!this.waiting.delete(conn)) return;
    const socket = this.sockets.get(conn);
    if (!socket) return;
    socket.on('data', (chunk: Buffer) => this.send(DATA, conn, chunk));
    socket.resume();
  }

  private send(kind: number, conn: number, payload: Buffer = Buffer.alloc(0)): void {
    const header = Buffer.alloc(HEADER_BYTES);
    header[0] = kind;
    header.writeUInt32BE(conn, 1);
    header.writeUInt32BE(payload.length, 5);
    this.entry.stdin?.write(Buffer.concat([header, payload]));
  }

  private read(chunk: Buffer): void {
    this.inbound = Buffer.concat([this.inbound, chunk]);
    while (this.inbound.length >= HEADER_BYTES) {
      const length = this.inbound.readUInt32BE(5);
      if (length > MAX_FRAME_BYTES) {
        this.entry.kill('SIGKILL');
        return;
      }
      if (this.inbound.length < HEADER_BYTES + length) return;
      this.frame(this.inbound[0], this.inbound.readUInt32BE(1), this.inbound.subarray(HEADER_BYTES, HEADER_BYTES + length));
      this.inbound = this.inbound.subarray(HEADER_BYTES + length);
    }
  }

  private frame(kind: number, conn: number, payload: Buffer): void {
    if (kind === READY) this.markReady();
    else if (kind === OPEN) this.open(conn, payload);
    else if (kind === OPENED) this.opened(conn);
    else if (kind === LISTENING && payload.length === 2) this.forwards.get(payload.readUInt16BE(0))?.heard();
    else if (kind === DATA) this.sockets.get(conn)?.write(payload);
    else if (kind === CLOSE) this.close(conn);
  }

  private open(conn: number, payload: Buffer): void {
    const forward = payload.length === 2 ? this.forwards.get(payload.readUInt16BE(0)) : undefined;
    if (!forward || this.sockets.has(conn)) {
      this.send(CLOSE, conn);
      return;
    }
    const socket = connect(forward.hostPort, '127.0.0.1');
    this.sockets.set(conn, socket);
    socket.on('data', (chunk: Buffer) => this.send(DATA, conn, chunk));
    const closed = () => {
      if (this.sockets.delete(conn)) this.send(CLOSE, conn);
    };
    socket.on('close', closed);
    socket.on('error', closed);
  }

  private close(conn: number): void {
    this.waiting.delete(conn);
    const socket = this.sockets.get(conn);
    this.sockets.delete(conn);
    socket?.destroy();
  }

  private gone(): void {
    for (const conn of [...this.sockets.keys()]) this.close(conn);
    for (const server of this.exposed) server.close();
    this.exposed.clear();
    const said = this.lastWords;
    const failure = new Error(`The container's entry ended${said ? `: ${said}` : '.'}`);
    this.failReady(failure);
    for (const forward of this.forwards.values()) forward.failed(failure);
  }
}
