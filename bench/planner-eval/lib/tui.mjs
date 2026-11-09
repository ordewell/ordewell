/**
 * The real `ordewell tui` under a pseudo-terminal, typed into as a person
 * would: text arrives as a bracketed paste and Enter sends it. No dependency
 * provides the terminal; `script(1)` does, which Linux and macOS ship (with
 * different flags). Windows has no `script`, so the bench refuses there.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const COLS = 160;
export const ROWS = 50;

/** One POSIX shell word. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The `script` invocation that runs `argv` on a fresh terminal of the given size. */
export function ptyCommand(argv, { platform = process.platform, cols = COLS, rows = ROWS } = {}) {
  const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${argv.map(shellQuote).join(' ')}`;
  if (platform === 'linux') return { command: 'script', args: ['-qfec', inner, '/dev/null'] };
  if (platform === 'darwin') return { command: 'script', args: ['-q', '/dev/null', 'sh', '-c', inner] };
  throw new Error(`the TUI driver needs script(1), which ${platform} does not have; run the bench on Linux or macOS`);
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** What the driver writes to type `text` and send it. */
export const typed = (text) => `${PASTE_START}${text}${PASTE_END}`;

// Cursor moves, colours, mode switches and OSC titles, so a screen log reads as text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s) => s.replace(ANSI, '');

/**
 * Start the TUI. Its raw output goes to `logFile` through `redact`, so the
 * screen of a run can be read back afterwards and never holds a key.
 */
export function startTui({ main, workspace, port, env, logFile, redact }) {
  const { command, args } = ptyCommand([process.execPath, main, 'tui', '--workspace', workspace, '--port', String(port)]);
  const child = spawn(command, args, { env, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  // A TUI that has exited closes its input; `alive` is how the driver learns that, not a write's error.
  child.stdin.on('error', () => {});
  const log = fs.openSync(logFile, 'a');
  let tail = '';
  const take = (chunk) => {
    const text = redact(chunk.toString('utf8'));
    fs.writeSync(log, text);
    tail = (tail + text).slice(-20_000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve) => child.on('close', (code, signal) => {
    fs.closeSync(log);
    resolve({ code, signal });
  }));
  let alive = true;
  exited.then(() => { alive = false; });
  return {
    exited,
    get alive() { return alive; },
    screen: () => stripAnsi(tail),
    async send(text) {
      child.stdin.write(typed(text));
      // A separate write, as a keypress after the paste: inside the paste a return is text.
      await new Promise((r) => setTimeout(r, 300));
      child.stdin.write('\r');
    },
    /** Quit as a terminal closing would: the TUI stops the daemon it started, then exits. */
    async stop(graceMs = 20_000) {
      if (!alive) return exited;
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (alive) child.kill('SIGKILL'); }, graceMs);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };
}
