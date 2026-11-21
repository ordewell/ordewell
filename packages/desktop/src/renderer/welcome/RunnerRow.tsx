import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleDashed, CircleHelp, CircleSlash, CircleX, ExternalLink, LogIn, KeyRound, RotateCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Button, Icon, RunnerBadge, runnerName } from '@ordewell/ui/design';
import type { AiProvider } from '@ordewell/core';
import { daemonWaitLine, DETECTING_AGENTS_DETAIL } from '@ordewell/core/plan-utils';
import type { DaemonStatus } from '../../shared/bridge';
import { cardFor } from '../DaemonBar';
import { KNOWN_RUNNERS, parseRunners, type RunnerLine } from '../runners';
import { askForKey, keyEntryEnv, keyEntryRefusal, unsavedKeyWarning, type KeyEntryRequest } from '../session/KeyEntryDialog';
import { DaemonCard, ErrorBanner, Skeleton } from './parts';
import { LoginDialog } from './LoginDialog';
import { RUNNERS_TIMEOUT_MS, failureMessage, noRunnerOn, runnerCard, runnerGroups, withTimeout, type RunnerTone } from './model';

type RunnersState =
  | { kind: 'loading' }
  | { kind: 'ready'; lines: RunnerLine[] }
  | { kind: 'error'; message: string; status?: number };

const TONE_ICON: Record<RunnerTone, LucideIcon> = {
  passed: CircleCheck,
  attention: TriangleAlert,
  idle: CircleHelp,
  failed: CircleX,
};

function RunnerCardView({ line, busy, onRetry, onLogin, onKey }: {
  line: RunnerLine;
  busy: boolean;
  onRetry(): void;
  onLogin(): void;
  onKey(provider: AiProvider): void;
}): JSX.Element {
  const name = line.name || runnerName(line.id);
  const card = runnerCard(line, name);
  const icon = line.state === 'off' ? CircleSlash : line.state === 'missing' ? CircleDashed : TONE_ICON[card.tone];
  return (
    <li className="welcome-card welcome-runner" data-runner={line.id} data-state={line.state}>
      <RunnerBadge runner={line.id} />
      <span className={`welcome-runner-state welcome-tone-${card.tone}`}>
        <Icon icon={icon} size={14} />
        <span>{card.word}</span>
      </span>
      {card.version && <span className="welcome-line welcome-muted" title={`version ${card.version}`}>version {card.version}</span>}
      {card.hint && <span className="welcome-line welcome-hint welcome-muted" title={card.hint}>{card.hint}</span>}
      {card.command && <code className="welcome-line welcome-code" title={card.command}>{card.command}</code>}
      {card.tone !== 'passed' && line.state !== 'off' && (
        <span className="welcome-card-actions">
          {card.action === 'login' && (
            <Button size="sm" icon={LogIn} disabled={busy} onClick={onLogin}>Log in</Button>
          )}
          {card.action === 'key' && card.provider && (
            <Button size="sm" icon={KeyRound} disabled={busy} onClick={() => { onKey(card.provider as AiProvider); }}>Set API key…</Button>
          )}
          <Button size="sm" icon={RotateCw} disabled={busy} onClick={onRetry}>Retry</Button>
          {card.docs && (
            <Button
              size="sm"
              variant="ghost"
              icon={ExternalLink}
              title={`Open ${name}'s install page`}
              onClick={() => { if (card.docs) void window.ordewell.shell.openExternal(card.docs); }}
            >
              Docs
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

function SkeletonRunner({ id }: { id: string }): JSX.Element {
  return (
    <li className="welcome-card welcome-runner" aria-hidden="true">
      <RunnerBadge runner={id} />
      <Skeleton width="short" />
      <Skeleton width="medium" />
    </li>
  );
}

/**
 * The installed agents, the working ones first, and the rest folded under
 * *More agents*: a first look should land on what works (F9). With nothing
 * installed the fold starts open, since the install pages are the next step.
 */
function ReadyRunners({ lines, busy, onRetry, onLogin, onKey }: {
  lines: RunnerLine[];
  busy: boolean;
  onRetry(): void;
  onLogin(line: RunnerLine): void;
  onKey(line: RunnerLine, provider: AiProvider): void;
}): JSX.Element {
  const { shown, more } = runnerGroups(lines);
  const cards = (group: RunnerLine[]): JSX.Element[] => group.map((line) => (
    <RunnerCardView
      key={line.id}
      line={line}
      busy={busy}
      onRetry={onRetry}
      onLogin={() => onLogin(line)}
      onKey={(provider) => onKey(line, provider)}
    />
  ));
  return (
    <>
      {shown.length > 0 && <ul className="welcome-grid welcome-runners">{cards(shown)}</ul>}
      {more.length > 0 && (
        <details className="welcome-more" open={shown.length === 0}>
          <summary className="welcome-more-summary">More agents ({more.length})</summary>
          <ul className="welcome-grid welcome-runners-more">{cards(more)}</ul>
        </details>
      )}
    </>
  );
}

/**
 * One card per runner from GET /api/runners. The call is bounded, so a daemon
 * that never answers ends in the error banner rather than a row that checks
 * for ever.
 */
export function RunnerRow({ status, platform }: { status: DaemonStatus | undefined; platform?: string }): JSX.Element {
  const connected = status?.state === 'connected';
  const [state, setState] = useState<RunnersState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<{ runner: string; label: string } | null>(null);
  const [keyError, setKeyError] = useState<string | undefined>(undefined);
  const [keyWarning, setKeyWarning] = useState<string | undefined>(undefined);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setBusy(true);
    const result = await withTimeout(window.ordewell.daemon.call('runners.list'), RUNNERS_TIMEOUT_MS, 'The daemon');
    if (mine !== generation.current) return;
    setBusy(false);
    if (!result.ok) {
      setState({ kind: 'error', message: failureMessage(result), ...(result.status !== undefined ? { status: result.status } : {}) });
      return;
    }
    const lines = parseRunners(result.data);
    setState(lines ? { kind: 'ready', lines } : { kind: 'error', message: 'The daemon answered with something that is not a runner list.', status: result.status });
  }, []);

  const setKey = useCallback(async (request: KeyEntryRequest): Promise<void> => {
    const answer = await askForKey(request);
    if (!answer) return;
    setKeyWarning(undefined);
    try {
      // The write a session's key entry sends, so Custom's endpoint is saved here too.
      const saved = await window.ordewell.daemon.call('settings.update', undefined, { env: keyEntryEnv(answer) });
      if (!saved.ok) {
        setKeyError(failureMessage(saved));
        return;
      }
      const refused = keyEntryRefusal(saved.data, answer.provider);
      if (refused) {
        setKeyError(refused);
        return;
      }
      setKeyError(undefined);
      setKeyWarning(unsavedKeyWarning(saved.data, answer.provider));
      await load();
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    }
  }, [load]);

  useEffect(() => {
    if (connected) void load();
    // A load that outlives its connection is not drawn.
    return () => { generation.current += 1; };
  }, [connected, load]);

  const pending = state.kind === 'loading';
  const card = status && status.state !== 'connecting' ? cardFor(status) : undefined;
  // Named from the first frame: a first probe on a cold machine is long, and
  // skeletons alone read as a window that is stuck.
  const waiting = !pending || card
    ? undefined
    : connected
      ? DETECTING_AGENTS_DETAIL
      : status?.state === 'connecting' ? daemonWaitLine(status.port, status.starting === true) : undefined;
  const retry = (): void => { void load(); };

  return (
    <section className="welcome-section" aria-labelledby="welcome-runners-heading" aria-busy={pending && !card}>
      <div className="welcome-heading-row">
        <h2 id="welcome-runners-heading" className="welcome-heading">Runners</h2>
        {waiting && <span className="welcome-loading" role="status">{waiting}</span>}
      </div>
      {card ? (
        <DaemonCard card={card} />
      ) : state.kind === 'error' ? (
        <ErrorBanner title="The daemon did not list its runners" message={state.message} route="GET /api/runners" status={state.status} busy={busy} onRetry={retry} />
      ) : state.kind === 'ready' && noRunnerOn(state.lines) ? (
        <p className="welcome-empty-line">No runners are on. Turn one on in Settings.</p>
      ) : (
        <>
          {keyError && <p className="welcome-banner welcome-banner-error" role="alert">{keyError}</p>}
          {keyWarning && <p className="welcome-banner welcome-banner-warning" role="status">{keyWarning}</p>}
          {state.kind === 'ready' ? (
            <ReadyRunners
              lines={state.lines}
              busy={busy}
              onRetry={retry}
              onLogin={(line) => setLogin({ runner: line.id, label: line.name || runnerName(line.id) })}
              onKey={(line, provider) => { void setKey({ provider, runnerLabel: runnerName(line.id) }); }}
            />
          ) : (
            <ul className="welcome-grid welcome-runners">
              {KNOWN_RUNNERS.map((id) => <SkeletonRunner key={id} id={id} />)}
            </ul>
          )}
          {/* A provider with no key has no card (ADR-0070), so its way in sits under them all, open to every provider. */}
          {state.kind === 'ready' && (
            <p className="welcome-key-line">
              <span>An API key adds the built-in runner on that provider, unless it is marked planner only.</span>
              <Button size="sm" icon={KeyRound} disabled={busy} onClick={() => { void setKey({}); }}>Set API key…</Button>
            </p>
          )}
        </>
      )}
      {login && (
        <LoginDialog
          runner={login.runner}
          label={login.label}
          platform={platform}
          onClose={() => setLogin(null)}
          onSignedIn={() => { void load(); }}
        />
      )}
    </section>
  );
}
