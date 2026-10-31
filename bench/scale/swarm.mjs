/**
 * Runners without their processes. `Swarm.spawn` stands where Node's `spawn`
 * does in a structured runner (`StructuredRunnerDeps.process`), so the real
 * ClaudeCodeAdapter, StructuredSession, task log, verifier, scheduler and MCP
 * server all run; what is fake is the process on the other side of the pipes,
 * and it speaks the stream-json protocol of `bench/pipeline/fake-claude`. One
 * Node process can then host more sessions than the machine could fork, and
 * what the daemon does per session is what gets measured.
 *
 * The event mix follows this repository's real attempt logs (real.mjs): three
 * in four thinking deltas, then tool calls and results, a usage report per
 * step. A real runner's own memory and CPU are not here, and nothing here says
 * what they cost.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough, Writable } from 'node:stream';

const MODEL = 'fake-claude';
const OUTPUT = 'src/services/PlanStore.ts:118:  load(tasks, runners): the store copies what it is given, and the getters hand out readonly views.\n'.repeat(30);
const THOUGHT = 'Reading the module to see what it holds before changing it. ';
const PARAGRAPH = `${'The change holds: the tests that cover the module pass, and nothing else moved. '.repeat(13).slice(0, 1023)}\n`;

/** One pass of the mix: fifteen deltas, a call, its result, a usage line. */
const CYCLE = 18;

class FakeProcess extends EventEmitter {
  pid = undefined;
  exitCode = null;
  signalCode = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  outbox = [];

  constructor(swarm, args, cwd) {
    super();
    this.swarm = swarm;
    this.cwd = cwd;
    this.sessionId = `fake-${swarm.spawned}`;
    this.mcpConfig = args[args.indexOf('--mcp-config') + 1];
    this.messages = 0;
    this.step = 0;
    this.turn = null;
    this.born = performance.now();
    let held = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        held += chunk.toString();
        for (let at = held.indexOf('\n'); at >= 0; at = held.indexOf('\n')) {
          this.line(held.slice(0, at));
          held = held.slice(at + 1);
        }
        done();
      },
      final: (done) => { this.end(0); done(); },
    });
    this.stdin.on('error', () => {});
    this.emitLine({ type: 'system', subtype: 'init', cwd, model: MODEL, permissionMode: 'bypassPermissions' });
  }

  kill() {
    this.killed = true;
    this.end(null, 'SIGTERM');
    return true;
  }

  end(code, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.swarm.exited(this);
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  /**
   * Handed over on a later turn of the event loop, as a pipe's read is: said
   * at once, a whole ramp or a stampede of verdicts would run as one chain of
   * promises, and stall the loop in a way a real runner's pipe never lets it.
   */
  emitLine(line) {
    if (this.stdout.writableEnded) return;
    this.outbox.push(`${JSON.stringify({ session_id: this.sessionId, parent_tool_use_id: null, ...line })}\n`);
    this.swarm.lines += 1;
    if (this.outbox.length > 1) return;
    setImmediate(() => {
      const text = this.outbox.join('');
      this.outbox = [];
      if (!this.stdout.writableEnded) this.stdout.write(text);
    });
  }

  line(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'control_request') this.control(msg);
    else if (msg.type === 'user') {
      if (msg.uuid) this.emitLine({ type: 'user', isReplay: true, uuid: msg.uuid, message: msg.message });
      void this.startTurn();
    }
  }

  control(msg) {
    const subtype = msg.request?.subtype;
    const answer = (response) => this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    if (subtype === 'interrupt' && this.turn) this.finish();
    if (subtype === 'initialize') answer({ commands: [], models: [] });
    else if (subtype === 'mcp_status') {
      // A real CLI takes its time to boot and connect: `attachMs` stands in for it.
      const left = this.swarm.attachMs - (performance.now() - this.born);
      const connected = () => answer({ mcpServers: [{ name: 'ordewell', status: 'connected' }] });
      if (left > 0) setTimeout(connected, left);
      else connected();
    } else answer({});
  }

  assistant(content) {
    this.messages += 1;
    this.emitLine({ type: 'assistant', message: { id: `msg_${this.sessionId}_${this.messages}`, model: MODEL, role: 'assistant', content } });
  }

  async startTurn() {
    if (this.turn) return;
    const { mcpServers } = JSON.parse(fs.readFileSync(this.mcpConfig, 'utf8'));
    const { url, headers } = mcpServers.ordewell;
    this.turn = { url, headers, left: this.swarm.eventsPerSession };
    this.assistant([{ type: 'text', text: 'Starting the task.' }]);
    await this.swarm.mcp?.attach(url, headers);
    this.swarm.ready(this);
  }

  /** The next event of the mix; false once this turn has said all it will. */
  emitEvent() {
    const { turn } = this;
    if (!turn) return false;
    if (turn.left <= 0) { void this.complete(); return false; }
    turn.left -= 1;
    const at = this.step % CYCLE;
    this.step += 1;
    this.swarm.events += 1;
    Atomics.store(this.swarm.pulse, 3, this.swarm.events);
    if (at < 15) {
      this.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: THOUGHT } } });
    } else if (at === 15) {
      this.toolId = `toolu_${this.sessionId}_${this.step}`;
      this.assistant([{ type: 'tool_use', id: this.toolId, name: 'Read', input: { file_path: `${this.cwd}/src/services/PlanStore.ts` } }]);
    } else if (at === 16) {
      this.emitLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: this.toolId, content: OUTPUT, is_error: false }] } });
    } else {
      // Token counts come from `message_delta` alone: the adapter ignores an `assistant` line's.
      this.emitLine({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 41415, output_tokens: 228, cache_read_input_tokens: 39000 } } });
      this.assistant([{ type: 'text', text: 'That read shows what the task needs.\n' }]);
    }
    return true;
  }

  async complete() {
    const { turn } = this;
    if (turn.completing) return;
    turn.completing = true;
    for (let kb = 0; kb < this.swarm.textKb; kb += 64) this.assistant([{ type: 'text', text: PARAGRAPH.repeat(64) }]);
    if (this.swarm.writes) fs.writeFileSync(`${this.cwd}/out-${this.sessionId}.txt`, 'done\n');
    const args = { status: 'done', summary: this.swarm.summary };
    const id = `toolu_${this.sessionId}_complete`;
    this.assistant([{ type: 'tool_use', id, name: 'mcp__ordewell__task_complete', input: args }]);
    const reply = this.swarm.mcp ? await this.swarm.mcp.complete(turn.url, turn.headers, args) : { text: 'Recorded.' };
    this.emitLine({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: reply.text, is_error: false }] } });
    this.finish();
  }

  finish() {
    if (!this.turn) return;
    this.assistant([{ type: 'text', text: 'All done.' }]);
    this.emitLine({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.16 });
    this.turn = null;
    this.swarm.done(this);
  }
}

/**
 * Every fake process, paced by one timer: each session emits `rate` events a
 * second for `eventsPerSession` events, then completes through the MCP server.
 * `hold` keeps every session quiet until {@link go}, so a run can be measured
 * with all of them up and nothing moving.
 */
export class Swarm {
  spawned = 0;
  live = new Set();
  active = new Set();
  lines = 0;
  events = 0;
  finished = 0;
  credit = 0;

  constructor({ rate = 5, eventsPerSession = 40, mcp = null, hold = false, textKb = 0, writes = false, attachMs = 0, pulse = new Int32Array(8), summary = 'Changed the module the task names and ran the tests that cover it; they pass.' }) {
    this.rate = rate;
    this.eventsPerSession = eventsPerSession;
    this.mcp = mcp;
    this.holding = hold;
    this.textKb = textKb;
    this.writes = writes;
    this.attachMs = attachMs;
    this.pulse = pulse;
    this.summary = summary;
    this.spawn = (_file, args, opts) => {
      this.spawned += 1;
      Atomics.store(this.pulse, 0, this.spawned);
      const child = new FakeProcess(this, args, opts.cwd);
      this.live.add(child);
      return child;
    };
    this.last = performance.now();
    this.timer = setInterval(() => this.pace(), 10);
    this.timer.unref();
  }

  ready(child) {
    this.active.add(child);
    Atomics.store(this.pulse, 1, this.active.size);
  }

  exited(child) {
    this.live.delete(child);
    this.active.delete(child);
  }

  done(child) {
    this.active.delete(child);
    this.finished += 1;
    Atomics.store(this.pulse, 2, this.finished);
  }

  go() {
    this.holding = false;
    this.last = performance.now();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Spends the time since the last pace as events, round the active sessions. At most a second's worth is owed: what a stalled loop could not offer is gone, and shows as a lower rate. */
  pace() {
    const t = performance.now();
    const elapsed = (t - this.last) / 1000;
    this.last = t;
    if (this.holding || this.active.size === 0) return;
    this.credit = Math.min(this.credit + elapsed * this.rate * this.active.size, this.active.size * this.rate);
    for (const child of [...this.active]) {
      if (this.credit < 1) break;
      // To the back of the line, so the credit goes round every session.
      this.active.delete(child);
      this.active.add(child);
      if (child.emitEvent()) this.credit -= 1;
    }
  }
}
