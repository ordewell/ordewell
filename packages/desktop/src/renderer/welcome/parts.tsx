import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@ordewell/ui/design';
import type { Action, Card } from '../DaemonBar';

/** A bar in place of text, at the text's own height, so nothing moves when the text arrives. */
export function Skeleton({ width }: { width: 'short' | 'medium' | 'long' }): JSX.Element {
  return <span className={`welcome-skeleton welcome-skeleton-${width}`} aria-hidden="true" />;
}

/** The shared error look: the daemon's words, Retry, and the route and status under Details. */
export function ErrorBanner({ title, message, route, status, busy, onRetry }: {
  title: string;
  message: string;
  route: string;
  status?: number;
  busy: boolean;
  onRetry(): void;
}): JSX.Element {
  return (
    <div className="welcome-banner welcome-banner-error" role="alert">
      <h3>{title}</h3>
      <p>{message}</p>
      <div className="welcome-banner-actions">
        <Button size="sm" icon={RotateCw} disabled={busy} onClick={onRetry}>Retry</Button>
        <details className="welcome-details">
          <summary>Details</summary>
          <code>{route} · {status === undefined ? 'no response' : `status ${status}`}</code>
        </details>
      </div>
    </div>
  );
}

/** The daemon's own card (design W15), where a region would otherwise claim a failure of its own. */
export function DaemonCard({ card }: { card: Card }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const run = async (action: Action): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    try {
      const result = await window.ordewell.daemon[action]();
      if (!result.ok && result.message) setRefusal(result.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`welcome-banner welcome-banner-${card.tone}`} role="alert">
      <h3>{card.title}</h3>
      <p>{card.body}</p>
      {refusal && <p className="welcome-refusal">{refusal}</p>}
      <div className="welcome-banner-actions">
        {card.actions.map(({ action, label }) => (
          <Button key={action} size="sm" disabled={busy} onClick={() => { void run(action); }}>{label}</Button>
        ))}
      </div>
    </div>
  );
}
