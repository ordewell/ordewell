import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, Kbd } from '@ordewell/ui/design';
import type { AppInfo, DaemonStatus, RecentWorkspace } from '../shared/bridge';
import { LogoMark, Wordmark } from './brand/Logo';
import { MAX_CARDS, modKey } from './welcome/model';
import { ErrorBanner, Skeleton } from './welcome/parts';
import { RecentCard } from './welcome/RecentCard';
import { RunnerRow } from './welcome/RunnerRow';
import { useLiveFacts } from './welcome/useLiveFacts';
import { WelcomeFooter } from './welcome/WelcomeFooter';

type Recents =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: RecentWorkspace[] }
  | { kind: 'error'; message: string };

interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

/** Long enough to reach Undo after reading the line. */
const TOAST_MS = 8_000;
/** Relative times are minutes at their finest, so redrawing them each minute keeps them true. */
const TICK_MS = 60_000;
const DROP_ONE = 'Drop one folder.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quitKeys(platform: string | undefined): string | undefined {
  // The menu's quit role: Cmd+Q on macOS, Ctrl+Q on Linux, and none on Windows, where Alt+F4 is the system's.
  if (platform === 'darwin') return '⌘Q';
  if (platform === 'linux') return 'Ctrl+Q';
  return undefined;
}

function SkeletonCard(): JSX.Element {
  return (
    <li className="welcome-card welcome-recent" aria-hidden="true">
      <Skeleton width="medium" />
      <Skeleton width="long" />
      <Skeleton width="short" />
      <Skeleton width="long" />
      <Skeleton width="short" />
    </li>
  );
}

/**
 * The welcome window (design W1): the wordmark, Open folder, the recent
 * projects as cards, the runners this machine has, and the daemon in the
 * footer. Everything it learns from the daemon goes through the bridge's
 * named routes; main holds the token (ADR-0060 H4).
 */
export function Welcome({ status }: { status: DaemonStatus | undefined }): JSX.Element {
  const [info, setInfo] = useState<AppInfo>();
  const [recents, setRecents] = useState<Recents>({ kind: 'loading' });
  const [showAll, setShowAll] = useState(false);
  const [toast, setToast] = useState<Toast>();
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const dragDepth = useRef(0);
  const toastIds = useRef(0);
  const entries = recents.kind === 'ready' ? recents.entries : undefined;
  const live = useLiveFacts(entries, status);

  const loadRecents = useCallback(async () => {
    try {
      setRecents({ kind: 'ready', entries: await window.ordewell.app.recentWorkspaces() });
    } catch (error) {
      setRecents({ kind: 'error', message: messageOf(error) });
    }
  }, []);

  useEffect(() => {
    void window.ordewell.app.info().then(setInfo, () => undefined);
    void loadRecents();
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, [loadRecents]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((shown) => (shown?.id === toast.id ? undefined : shown)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const say = useCallback((message: string, undo?: () => void) => {
    toastIds.current += 1;
    setToast({ id: toastIds.current, message, ...(undo ? { undo } : {}) });
  }, []);

  const open = useCallback(async (path?: string) => {
    await window.ordewell.app.openWorkspace(path);
    await loadRecents();
  }, [loadRecents]);

  const forget = useCallback(async (entry: RecentWorkspace) => {
    setRecents({ kind: 'ready', entries: await window.ordewell.app.forgetWorkspace(entry.path) });
    say(`Forgot ${entry.name}.`, () => {
      setToast(undefined);
      void window.ordewell.app.unforgetWorkspace(entry.path).then((restored) => setRecents({ kind: 'ready', entries: restored }));
    });
  }, [say]);

  const platform = info?.platform;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'o') return;
      event.preventDefault();
      void open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [platform, open]);

  // Enter and leave fire for every child the drag crosses, so a depth count says when it has left the window.
  const onDragEnter = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = event.dataTransfer.files;
    const first = files.item(0);
    if (files.length !== 1 || !first) {
      say(DROP_ONE);
      return;
    }
    // Main checks the path is a folder on disk; the page cannot tell a folder from a file.
    void window.ordewell.app.openDroppedFolder(first).then(async (result) => {
      if (!result.ok) say(result.message ?? DROP_ONE);
      await loadRecents();
    });
  };

  const mod = modKey(platform);
  const quit = quitKeys(platform);
  const shown = entries && !showAll ? entries.slice(0, MAX_CARDS) : entries;

  return (
    <div
      className={dragging ? 'welcome welcome-dragging' : 'welcome'}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <main className="welcome-body">
        <div className="welcome-content">
          <header className="welcome-hero">
            <h1 className="welcome-logo"><Wordmark /></h1>
            <p className="welcome-tagline">Turn one goal into an ordered plan of agent tasks</p>
            <div className="welcome-open">
              <Button
                variant="primary"
                size="lg"
                icon={FolderOpen}
                aria-keyshortcuts={platform === undefined ? undefined : platform === 'darwin' ? 'Meta+O' : 'Control+O'}
                onClick={() => { void open(); }}
              >
                Open folder…
                {info && <span className="welcome-button-kbd" aria-hidden="true"><Kbd>{mod}O</Kbd></span>}
              </Button>
              <span className="welcome-muted">or drop a folder on this window</span>
            </div>
          </header>

          <section className="welcome-section" aria-labelledby="welcome-recents-heading" aria-busy={recents.kind === 'loading'}>
            <div className="welcome-heading-row">
              <h2 id="welcome-recents-heading" className="welcome-heading">Recent projects</h2>
            </div>
            {recents.kind === 'error' ? (
              <ErrorBanner
                title="The recent projects could not be read"
                message={recents.message}
                route="app.recentWorkspaces"
                busy={false}
                onRetry={() => { setRecents({ kind: 'loading' }); void loadRecents(); }}
              />
            ) : entries && entries.length === 0 ? (
              <div className="welcome-card welcome-empty">
                <LogoMark size={40} />
                <p>Open a folder to start. A workspace is a folder, usually a git repository or a folder of them.</p>
              </div>
            ) : (
              <>
                <ul className="welcome-grid welcome-recents">
                  {shown
                    ? shown.map((entry) => (
                      <RecentCard
                        key={entry.path}
                        entry={entry}
                        live={live(entry.path)}
                        now={now}
                        onOpen={(path) => { void open(path); }}
                        onForget={(gone) => { void forget(gone); }}
                      />
                    ))
                    : [0, 1, 2].map((slot) => <SkeletonCard key={slot} />)}
                </ul>
                {entries && entries.length > MAX_CARDS && (
                  <Button size="sm" variant="ghost" className="welcome-show-all" onClick={() => setShowAll((all) => !all)}>
                    {showAll ? 'Show fewer' : `Show all (${entries.length})`}
                  </Button>
                )}
              </>
            )}
          </section>

          <RunnerRow status={status} />

          {info && (
            <p className="welcome-hints">
              <span><Kbd>{mod}O</Kbd> Open folder</span>
              <span><Kbd>Enter</Kbd> Open project</span>
              {quit && <span><Kbd>{quit}</Kbd> Quit</span>}
            </p>
          )}
        </div>
      </main>

      {toast && (
        <div className="welcome-toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && <Button size="sm" variant="ghost" onClick={toast.undo}>Undo</Button>}
        </div>
      )}

      {dragging && (
        <div className="welcome-drop" aria-hidden="true">
          <span>Drop a folder to open it</span>
        </div>
      )}

      <WelcomeFooter version={info?.version} status={status} />
    </div>
  );
}
