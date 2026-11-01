import type { ChildProcess } from 'child_process';
import { connect, type Socket } from 'net';

/*
 * One frame, either way: its kind, its connection and its length, then that
 * many bytes. READY and LISTENING go up from the entry; LISTEN goes down to it;
 * the rest go both ways, for one connection.
 */
const HEADER_BYTES = 9;
const READY = 1;
const OPEN = 2;
const DATA = 3;
const CLOSE = 4;
const LISTEN = 5;
const LISTENING = 6;

/** Past any chunk a socket reads. Anything longer is a process in the container writing to the entry's stdout. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const STDERR_TAIL_CHARS = 2000;

/**
 * What a lease's container runs as its one idle process (ADR-0059 L5), handed
 * to `node -e`, so an image needs node and no file of Ordewell's. It listens on
 * the container's own loopback for each port the host asks for and carries every
 * connection over its stdin and stdout. Its stdin is what keeps the container:
 * when the host goes, by any death, the pipe closes, this exits and `--rm` takes
 * the container with everything in it, so nothing needs a timer to renew.
 */
export const RELAY_ENTRY = String.raw`
const net = require('net');
const [READY, OPEN, DATA, CLOSE, LISTEN, LISTENING] = [1, 2, 3, 4, 5, 6];
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
function frame(kind, conn, payload) {
  if (kind === LISTEN) listen(payload.readUInt16BE(0));
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
  private stderrTail = '';
  private markReady!: () => void;
  private failReady!: (err: Error) => void;

  constructor(private readonly entry: ChildProcess) {
    this.ready = new Promise<void>((resolve, reject) => { this.markReady = resolve; this.failReady = reject; });
    // A start that failed is reported to whoever awaits it; a relay nobody awaited has nobody to tell.
    this.ready.catch(() => undefined);
    this.ended = new Promise<void>((resolve) => {
      entry.once('close', () => { this.gone(); resolve(); });
      entry.once('error', (err) => { this.stderrTail += err.message; this.gone(); resolve(); });
    });
    entry.stdin?.on('error', () => undefined);
    entry.stderr?.on('data', (chunk: Buffer) => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS); });
    entry.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
  }

  /** What the entry last wrote to stderr: the one explanation a container that would not start leaves. */
  get lastWords(): string { return this.stderrTail.trim(); }

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
    const socket = this.sockets.get(conn);
    this.sockets.delete(conn);
    socket?.destroy();
  }

  private gone(): void {
    for (const conn of [...this.sockets.keys()]) this.close(conn);
    const failure = new Error(`The container's entry ended${this.lastWords ? `: ${this.lastWords}` : '.'}`);
    this.failReady(failure);
    for (const forward of this.forwards.values()) forward.failed(failure);
  }
}
