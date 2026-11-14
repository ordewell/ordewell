import { createServer, type Server, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Option+Left/Right as word movement in the user's zsh, and nowhere else
 * (ADR-0069). No byte goes to the pty. The shell's line editor connects once,
 * at startup, to a private socket; the chord asks it to move, and it moves
 * only when it can show it is idle at a top-level prompt. Every other case
 * (another program in the foreground, a search or a menu, a key half typed,
 * another shell) swallows the chord, as the renderer did before.
 *
 * Order is kept by holding the keys typed after the chord until the shell has
 * answered, and by asking only once the keys typed before it have reached the
 * pty: zsh reads its terminal before it runs a watched descriptor's handler.
 */

export type WordDirection = 'left' | 'right';

/** The pty the link writes keystrokes to: node-pty's terminal, read for its unwritten queue. */
export interface WordPty {
  write(data: string): void;
}

/** How long the shell has to say it can move: past this it is not at its prompt. */
const READY_MS = 150;
/** How long keys are held after the shell was told to go; a live shell answers at once. */
const DONE_MS = 1000;
const DRAIN_POLL_MS = 2;
const MAX_LINE = 256;

/**
 * True when node-pty still holds bytes it has not written to the terminal; it
 * writes asynchronously, so a key typed before the chord may not be there yet.
 * Undefined for a pty whose shape this does not know, which refuses the move.
 */
function writesPending(pty: object): boolean | undefined {
  const stream: unknown = Reflect.get(pty, '_writeStream');
  if (typeof stream !== 'object' || stream === null) return undefined;
  const queue: unknown = Reflect.get(stream, '_writeQueue');
  return Array.isArray(queue) ? queue.length > 0 : undefined;
}

/**
 * Whether a terminal gets the link: Apple's zsh, with no zshenv anywhere. The
 * link's own zshenv stands in for the user's, so it is used only where there
 * is none to stand in for; a shell with one keeps its startup untouched.
 */
export function wordLinkFits(platform: NodeJS.Platform, file: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): boolean {
  if (platform !== 'darwin' || file !== '/bin/zsh') return false;
  const dotdir = env.ZDOTDIR === undefined ? env.HOME : env.ZDOTDIR;
  if (!dotdir) return false;
  return !['/etc/zshenv', '/etc/zshenv.zwc', join(dotdir, '.zshenv'), join(dotdir, '.zshenv.zwc')].some(exists);
}

/** The link for a shell that fits it, or none: a link that cannot open leaves the chord doing nothing. */
export async function openWordLink(platform: NodeJS.Platform, file: string, env: Record<string, string>): Promise<WordLink | undefined> {
  if (!wordLinkFits(platform, file, env)) return undefined;
  try {
    return await WordLink.open(env);
  } catch {
    return undefined;
  }
}

/**
 * The zshenv zsh reads from the link's directory. It puts ZDOTDIR back first,
 * so zsh reads the user's own .zprofile, .zshrc and .zlogin as it would have.
 * It binds no key: the user's keymaps and widgets are left as they are, and
 * the moves call the builtin widgets (the leading dot), not a user's override.
 */
export const ZSHENV = `# Ordewell's terminal: Option+Left/Right as word movement (ADR-0069).
if (( \${+ORDEWELL_USER_ZDOTDIR} )); then ZDOTDIR=$ORDEWELL_USER_ZDOTDIR; else unset ZDOTDIR; fi
() {
  emulate -L zsh
  local sock=$ORDEWELL_WORD_SOCKET
  unset ORDEWELL_USER_ZDOTDIR ORDEWELL_WORD_SOCKET
  [[ -o interactive && -n $sock ]] || return 0
  zmodload zsh/net/socket 2>/dev/null && zsocket $sock 2>/dev/null || return 0
  typeset -gi _ordewell_word_fd=$REPLY

  # Idle at a top-level prompt: no key half read, no search, menu, minibuffer,
  # vared, select, recursive edit or pending vi operator, in a stock keymap.
  _ordewell_word_check() {
    emulate -L zsh
    [[ $CONTEXT == start && -z $KEYS && $ZLE_RECURSIVE == 0 && $MARK -ge 0 ]] || return 0
    [[ $SUFFIX_ACTIVE == 0 && $ISEARCHMATCH_ACTIVE == 0 && $funcstack[-1] == _ordewell_word_handler ]] || return 0
    [[ $KEYMAP == (main|emacs|viins|vicmd) ]] || return 0
    [[ $LASTWIDGET == (*complet*|*expand*|*list*|*menu*|*search*|*named-cmd|where-is|describe-key-briefly|read-command|recursive-edit) ]] && return 0
    typeset -g _ordewell_word_keymap=$KEYMAP
  }
  zle -N zle-ordewell-word-check _ordewell_word_check

  _ordewell_word_handler() {
    emulate -L zsh
    local fd=$1 line req widget
    if ! read -r -u $fd line; then
      zle -F $fd
      exec {fd}<&-
      return 0
    fi
    while :; do
      [[ $line == req\\ <->\\ [lr] ]] && req=$line
      read -t 0 -r -u $fd line || break
    done
    [[ -n $req ]] || return 0
    local n=\${\${req#req }% *}
    typeset -g _ordewell_word_keymap=
    zle zle-ordewell-word-check -f nolast
    if [[ -z $_ordewell_word_keymap ]]; then
      print -r -u $fd -- "no $n"
      return 0
    fi
    case $_ordewell_word_keymap:\${req[-1]} in
      (vicmd:l) widget=.vi-backward-word ;;
      (vicmd:r) widget=.vi-forward-word ;;
      (*:l) widget=.backward-word ;;
      (*) widget=.emacs-forward-word ;;
    esac
    print -r -u $fd -- "ready $n"
    read -t 0.5 -r -u $fd line && [[ $line == "go $n" ]] || return 0
    zle $widget -f nolast
    zle -R
    print -r -u $fd -- "done $n"
  }
  zle -F $_ordewell_word_fd _ordewell_word_handler
}
`;

interface InFlight {
  n: number;
  /** drain: waiting for earlier keys to reach the pty; asked: the shell has the request; go: it was told to move. */
  phase: 'drain' | 'asked' | 'go';
  timer: NodeJS.Timeout;
}

export class WordLink {
  private socket: Socket | undefined;
  private pty: WordPty | undefined;
  private linked: (() => void) | undefined;
  private inFlight: InFlight | undefined;
  private held: string[] = [];
  /** A request went unanswered: the shell is not at its prompt, so the chord swallows until it speaks again. */
  private quiet = false;
  private next = 1;
  private disposed = false;

  private constructor(
    private readonly dir: string,
    private readonly server: Server,
    /** What the shell starts with on top of its environment. */
    readonly env: Record<string, string>,
  ) {
    server.on('connection', (socket) => this.connected(socket));
  }

  /** A link waiting for its shell: a private directory with the zshenv and a socket that accepts once. */
  static async open(userEnv: NodeJS.ProcessEnv, base: string = tmpdir()): Promise<WordLink> {
    const dir = await mkdtemp(join(base, 'ordewell-words-'));
    try {
      await chmod(dir, 0o700);
      await writeFile(join(dir, '.zshenv'), ZSHENV, { mode: 0o600 });
      const path = join(dir, 's');
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => { server.off('error', reject); resolve(); });
      });
      return new WordLink(dir, server, {
        ZDOTDIR: dir,
        ORDEWELL_WORD_SOCKET: path,
        ...(userEnv.ZDOTDIR === undefined ? {} : { ORDEWELL_USER_ZDOTDIR: userEnv.ZDOTDIR }),
      });
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Binds the link to the shell it was started for; `linked` runs once the shell's line editor connects. */
  attach(pty: WordPty, linked: () => void): void {
    this.pty = pty;
    this.linked = linked;
    if (this.socket) linked();
  }

  /** Keystrokes: straight to the pty, or held behind a move the shell has not finished. */
  write(data: string): void {
    if (this.inFlight) this.held.push(data);
    else this.pty?.write(data);
  }

  /** The chord. Without a link, with a move in flight or with the shell busy, it does nothing. */
  word(direction: WordDirection): void {
    if (!this.socket || !this.pty || this.inFlight || this.quiet) return;
    const n = this.next++;
    this.inFlight = { n, phase: 'drain', timer: setTimeout(() => this.timedOut(n), READY_MS) };
    this.drain(n, direction);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.inFlight) clearTimeout(this.inFlight.timer);
    this.inFlight = undefined;
    this.held = [];
    this.pty = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.server.close();
    void rm(this.dir, { recursive: true, force: true });
  }

  private connected(socket: Socket): void {
    // One shell, once: the path goes, so a nested zsh or anything else finds nothing to join.
    this.server.close();
    void rm(this.dir, { recursive: true, force: true });
    if (this.socket || this.disposed) { socket.destroy(); return; }
    this.socket = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        this.heard(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
      if (buffer.length > MAX_LINE) socket.destroy();
    });
    const gone = (): void => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.inFlight) this.finish(this.inFlight.n);
    };
    socket.on('close', gone);
    socket.on('error', gone);
    this.linked?.();
  }

  private drain(n: number, direction: WordDirection): void {
    const flight = this.inFlight;
    if (!flight || flight.n !== n || !this.pty || !this.socket) return;
    const pending = writesPending(this.pty);
    if (pending === undefined) { this.finish(n); return; }
    if (pending) { setTimeout(() => this.drain(n, direction), DRAIN_POLL_MS); return; }
    flight.phase = 'asked';
    this.socket.write(`req ${n} ${direction === 'left' ? 'l' : 'r'}\n`);
  }

  private heard(line: string): void {
    const match = /^(ready|no|done) (\d+)$/.exec(line);
    if (!match) return;
    this.quiet = false;
    const n = Number(match[2]);
    const flight = this.inFlight?.n === n ? this.inFlight : undefined;
    if (match[1] !== 'ready') {
      if (flight) this.finish(n);
      return;
    }
    // A shell that answers late, once the held keys went on without the move, is told not to move.
    if (!flight || flight.phase !== 'asked') { this.socket?.write(`no ${n}\n`); return; }
    clearTimeout(flight.timer);
    flight.phase = 'go';
    flight.timer = setTimeout(() => this.finish(n), DONE_MS);
    this.socket?.write(`go ${n}\n`);
  }

  private timedOut(n: number): void {
    if (this.inFlight?.n !== n) return;
    if (this.inFlight.phase === 'asked') this.quiet = true;
    this.finish(n);
  }

  private finish(n: number): void {
    if (this.inFlight?.n !== n) return;
    clearTimeout(this.inFlight.timer);
    this.inFlight = undefined;
    const held = this.held.join('');
    this.held = [];
    if (held !== '') this.pty?.write(held);
  }
}
