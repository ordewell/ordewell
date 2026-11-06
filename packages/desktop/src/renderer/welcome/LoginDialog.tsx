import { useEffect, useRef, useState } from 'react';
import { Button } from '@ordewell/ui/design';
import type { TerminalEvent } from '../../shared/bridge';
import { isMac } from '../frame/keys';
import { SIGN_IN_CLOSED, SIGN_IN_TIMEOUT, waitForSignIn } from '../session/signInWait';
import type { TermHandle } from '../views/terminal/xterm';

type Phase =
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string };

export interface LoginDialogProps {
  runner: string;
  label: string;
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
export function LoginDialog({ runner, label, platform, onClose, onSignedIn, pollMs, timeoutMs }: LoginDialogProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<TermHandle | null>(null);
  const pty = useRef<number | undefined>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  useEffect(() => {
    let live = true;
    let ended: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { ended = resolve; });

    const run = async (): Promise<void> => {
      try {
        const { createTerm } = await import('../views/terminal/xterm');
        const handle = await createTerm({
          onData: (data) => { if (pty.current !== undefined) void window.ordewell.terminal.write(pty.current, data); },
          onLink: (url) => { void window.ordewell.terminal.openLink(url); },
          screenReaderMode: false,
        }, isMac(platform ?? ''));
        if (!live) { handle.dispose(); return; }
        term.current = handle;
        if (screen.current) handle.mount(screen.current);
        const size = handle.size();
        const result = await window.ordewell.terminal.open(
          { repo: '.', scope: { kind: 'checkout' }, cols: size.cols, rows: size.rows, login: { runner } },
          (event: TerminalEvent) => {
            if (event.kind === 'data') { handle.write(event.data); return; }
            handle.write('\r\n\x1b[2m[Process exited.]\x1b[0m\r\n');
            pty.current = undefined;
            ended();
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
          ...(pollMs !== undefined ? { pollMs } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          signedIn: async () => {
            const answer = await window.ordewell.daemon.call('runners.list');
            const runners = answer.ok && typeof answer.data === 'object' && answer.data !== null
              ? Reflect.get(answer.data, 'runners')
              : undefined;
            if (!Array.isArray(runners)) return false;
            return runners.some((entry: unknown) => (
              typeof entry === 'object' && entry !== null
              && Reflect.get(entry, 'id') === runner
              && Reflect.get(Reflect.get(entry, 'auth') ?? {}, 'state') === 'signed-in'
            ));
          },
        });
        if (!live) return;
        if (outcome.ok) {
          setPhase({ kind: 'done', message: `${label} is signed in.` });
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
  }, [runner, label, platform]);

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
        <p id="welcome-login-title" className="welcome-login-title">Sign in to {label}</p>
        <div ref={screen} className="welcome-login-terminal" aria-label={`${label} login terminal`} />
        <p className="welcome-login-status" role="status">
          {phase.kind === 'starting' ? 'Starting the login terminal…' : null}
          {phase.kind === 'running' ? 'Waiting for the sign-in to finish…' : null}
          {phase.kind === 'done' ? phase.message : null}
          {failed ? `Sign-in did not finish. ${phase.message}` : null}
        </p>
        {failed && (phase.message === SIGN_IN_CLOSED || phase.message === SIGN_IN_TIMEOUT) && (
          <p className="welcome-login-hint">The agent's own command is in the terminal above. Close this, then choose Log in to run it again.</p>
        )}
        <div className="welcome-login-actions">
          <Button size="sm" onClick={() => close.current()}>{phase.kind === 'done' ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  );
}
