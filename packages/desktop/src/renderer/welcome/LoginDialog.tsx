import { useEffect, useRef, useState } from 'react';
import { CircleX } from 'lucide-react';
import { Button, Icon } from '@ordewell/ui/design';
import { runnerEntryReadiness, type RunnerReadinessFields, type RunnerSignIn } from '@ordewell/core/plan-utils';
import type { TerminalEvent } from '../../shared/bridge';
import { readClipboardText, writeClipboardText } from '../clipboard';
import { isMac } from '../frame/keys';
import { SIGN_IN_CLOSED, SIGN_IN_TIMEOUT, waitForSignIn } from '../session/signInWait';
import type { TermHandle } from '../views/terminal/xterm';
import { welcomeSignIn } from './model';

type Phase =
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string };

export interface LoginDialogProps {
  runner: string;
  label: string;
  /**
   * The agent only lacks a provider key, and this login is its own setup of one
   * (Cline's `cline auth`, ADR-0060): worded as that setup, never as a sign-in.
   */
  setsUp?: boolean;
  platform: string | undefined;
  onClose(): void;
  /** The agent's status command now says signed in: the runner card is re-read. */
  onSignedIn(): void;
  /** The poll interval and the budget, each overridable by a test. */
  pollMs?: number;
  timeoutMs?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A coding agent's own login, in a terminal drawn over the launcher (ADR-0052).
 * The launcher has no checkout, so the login runs in the same home directory
 * the daemon does; its argv is core's and main's, never a string built here.
 */
export function LoginDialog({ runner, label, setsUp = false, platform, onClose, onSignedIn, pollMs, timeoutMs }: LoginDialogProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  // A failed copy or paste leaves the sign-in running, so it is said apart from the phase.
  const [clipboardNote, setClipboardNote] = useState<string | undefined>(undefined);
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<TermHandle | null>(null);
  const pty = useRef<number | undefined>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  useEffect(() => {
    let live = true;
    let ended: (code?: number) => void = () => undefined;
    const done = new Promise<number | void>((resolve) => { ended = resolve; });

    const run = async (): Promise<void> => {
      try {
        const { createTerm } = await import('../views/terminal/xterm');
        const handle = await createTerm({
          onData: (data) => { if (pty.current !== undefined) void window.ordewell.terminal.write(pty.current, data); },
          onLink: (url) => { void window.ordewell.terminal.openLink(url); },
          screenReaderMode: false,
          readClipboard: readClipboardText,
          writeClipboard: writeClipboardText,
          onClipboardError: (title, reason) => { if (live) setClipboardNote(`${title}: ${reason}`); },
        }, isMac(platform ?? ''));
        if (!live) { handle.dispose(); return; }
        term.current = handle;
        if (screen.current) handle.mount(screen.current);
        const size = handle.size();
        const result = await window.ordewell.terminal.open(
          { repo: '.', scope: { kind: 'checkout' }, cols: size.cols, rows: size.rows, login: { runner } },
          (event: TerminalEvent) => {
            if (event.kind === 'data') { handle.write(event.data); return; }
            if (event.kind !== 'exit') return;
            handle.write('\r\n\x1b[2m[Process exited.]\x1b[0m\r\n');
            pty.current = undefined;
            ended(event.exitCode);
          },
        );
        if (!live) { if (result.ok) void window.ordewell.terminal.close(result.id); return; }
        if (!result.ok) {
          setPhase({ kind: 'failed', message: result.message });
          ended();
          return;
        }
        pty.current = result.id;
        setPhase({ kind: 'running' });
        handle.focus();
        const outcome = await waitForSignIn({
          ended: done,
          label,
          // A login that exited cleanly is the user's recovery: the daemon
          // forgets the refusal it recorded and asks again (ADR-0052). Its ways
          // in come back too, so a key still missing is said as that, as the chat does.
          recheck: async () => {
            const answer = await window.ordewell.daemon.call('runners.list', { recheck: runner });
            return recheckVerdictOf(answer.ok ? answer.data : undefined, runner);
          },
          syntax: welcomeSignIn(setsUp ? label : undefined),
          ...(pollMs !== undefined ? { pollMs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          signedIn: async () => {
            const answer = await window.ordewell.daemon.call('runners.list');
            return authStateOf(answer.ok ? answer.data : undefined, runner) === 'signed-in';
          },
        });
        if (!live) return;
        if (outcome.ok) {
          setPhase({ kind: 'done', message: setsUp ? `${label} is set up.` : `${label} is signed in.` });
          signedIn.current();
          return;
        }
        setPhase({ kind: 'failed', message: outcome.message ?? SIGN_IN_CLOSED });
      } catch (err) {
        if (!live) return;
        setPhase({ kind: 'failed', message: `The login terminal could not be opened. ${messageOf(err)}` });
        ended();
      }
    };
    void run();

    return () => {
      live = false;
      ended();
      if (pty.current !== undefined) void window.ordewell.terminal.close(pty.current);
      pty.current = undefined;
      term.current?.dispose();
      term.current = null;
    };
  }, [runner, label, setsUp, platform]);

  useEffect(() => {
    const element = screen.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const handle = term.current;
      if (!handle) return;
      const size = handle.fit();
      if (pty.current !== undefined) void window.ordewell.terminal.resize(pty.current, size.cols, size.rows);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const failed = phase.kind === 'failed';
  return (
    <div className="frame-scrim welcome-login-scrim">
      <div
        className="welcome-login"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-login-title"
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close.current(); } }}
      >
        <p id="welcome-login-title" className="welcome-login-title">{setsUp ? `Set up ${label}` : `Sign in to ${label}`}</p>
        <div ref={screen} className="welcome-login-terminal" aria-label={`${label} login terminal`} />
        {/* A failure is announced as an alert and led by what happened; the agent's own words follow it. */}
        <p className={`welcome-login-status${failed ? ' welcome-login-failed' : ''}`} role={failed ? 'alert' : 'status'}>
          {failed && <Icon icon={CircleX} size={16} />}
          {phase.kind === 'starting' ? 'Starting the login terminal…' : null}
          {phase.kind === 'running' ? (setsUp ? 'Waiting for the setup to finish…' : 'Waiting for the sign-in to finish…') : null}
          {phase.kind === 'done' ? phase.message : null}
          {failed ? (
            <span>
              <strong>{setsUp ? `${label} is not set up yet.` : 'Sign-in did not finish.'}</strong>{' '}{phase.message}
            </span>
          ) : null}
        </p>
        {clipboardNote !== undefined && (
          <p className="welcome-login-hint" role="alert">{clipboardNote}</p>
        )}
        {failed && (phase.message === SIGN_IN_CLOSED || phase.message === SIGN_IN_TIMEOUT) && (
          <p className="welcome-login-hint">The agent's own command is in the terminal above. Close this, then choose {setsUp ? `Set up ${label}` : 'Log in'} to run it again.</p>
        )}
        <div className="welcome-login-actions">
          <Button size="sm" onClick={() => close.current()}>{phase.kind === 'done' ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  );
}

type AuthState = 'signed-in' | 'signed-out' | 'unknown';

/** `runner`'s row in a runner list, read from the daemon's untyped answer. */
function entryOf(data: unknown, runner: string): Record<string, unknown> | undefined {
  const runners = typeof data === 'object' && data !== null ? Reflect.get(data, 'runners') : undefined;
  if (!Array.isArray(runners)) return undefined;
  const entry: unknown = runners.find((row: unknown) => typeof row === 'object' && row !== null && Reflect.get(row, 'id') === runner);
  return typeof entry === 'object' && entry !== null ? entry as Record<string, unknown> : undefined;
}

/** The login verdict a runner list gives `runner`. */
function authStateOf(data: unknown, runner: string): AuthState | undefined {
  const auth = entryOf(data, runner)?.auth;
  const state: unknown = typeof auth === 'object' && auth !== null ? Reflect.get(auth, 'state') : undefined;
  return state === 'signed-in' || state === 'signed-out' || state === 'unknown' ? state : undefined;
}

/**
 * The verdict and the ways in its readiness carries, as the chat's recheck
 * reads them (DaemonHost): the readiness marks a missing key the verdict alone may not.
 */
function recheckVerdictOf(data: unknown, runner: string): { state: AuthState; signIn?: RunnerSignIn } | undefined {
  const state = authStateOf(data, runner);
  if (!state) return undefined;
  // The daemon's own row, shaped by core's contract; core's reading of it is the one every host uses.
  const entry = entryOf(data, runner) as RunnerReadinessFields;
  const readiness = runnerEntryReadiness(entry);
  const signIn = readiness.kind === 'blocked' ? readiness.signIn : entry.auth?.signIn;
  return { state, ...(signIn ? { signIn } : {}) };
}
