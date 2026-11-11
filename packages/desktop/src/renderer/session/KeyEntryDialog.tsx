import { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@ordewell/ui/design';
import type { AiProvider } from '@ordewell/core';
import { PROVIDER_PRIORITY, VENDORS } from '@ordewell/core/plan-utils';
import './confirm.css';

/**
 * The key entry (ADR-0052): one vendor, one secret. The key never leaves this
 * dialog's own state until it is resolved to the caller, which writes it
 * through the daemon and drops it (ADR-0061).
 */
export interface KeyEntryRequest {
  /** The vendor a runner's key route names; absent asks which vendor. */
  provider?: AiProvider;
  /** The agent this key signs in, so the person knows what they are configuring. */
  runnerLabel?: string;
}

export interface KeyEntryAnswer {
  provider: AiProvider;
  key: string;
}

interface DialogProps {
  request: KeyEntryRequest;
  answer(result: KeyEntryAnswer | null): void;
}

/** One provider's name, as core words it. */
function providerName(provider: AiProvider): string {
  return VENDORS[provider].label;
}

export function KeyEntryDialog({ request, answer }: DialogProps): JSX.Element {
  const [provider, setProvider] = useState<AiProvider>(request.provider ?? PROVIDER_PRIORITY[0]);
  const [key, setKey] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const meta = VENDORS[provider];
  const ready = key.trim() !== '';

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    return () => before?.focus();
  }, []);

  return (
    <div className="frame-scrim session-confirm-scrim">
      <div
        ref={panel}
        className="session-confirm key-entry"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); answer(null); return; }
          // A modal keeps Tab inside it: the window behind cannot be acted on until it is answered.
          if (event.key !== 'Tab') return;
          const controls = [...(panel.current?.querySelectorAll<HTMLElement>('input, select, button') ?? [])].filter((el) => !el.hasAttribute('disabled'));
          const at = controls.indexOf(document.activeElement as HTMLElement);
          const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : (at + 1) % controls.length;
          event.preventDefault();
          controls[next]?.focus();
        }}
      >
        <p id={titleId} className="session-confirm-message">API key for {providerName(provider)}</p>
        <p id={hintId} className="session-confirm-detail">
          {request.runnerLabel
            ? <>Ordewell hands this key to {request.runnerLabel}. It is stored as <code>{meta.apiKeyEnvVar}</code> and never shown again.</>
            : <>Ordewell uses it as <code>{meta.apiKeyEnvVar}</code>, and never shows it again.</>}
        </p>
        {request.provider === undefined && (
          <label className="key-entry-field">
            <span>Provider</span>
            <select className="ow-select" value={provider} onChange={(event) => setProvider(event.target.value as AiProvider)} aria-label="Provider">
              {PROVIDER_PRIORITY.map((id) => <option key={id} value={id}>{providerName(id)}</option>)}
            </select>
          </label>
        )}
        <label className="key-entry-field">
          <span>API key</span>
          <input
            ref={field}
            type="password"
            className="key-entry-input"
            aria-label="API key"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ready) { event.preventDefault(); answer({ provider, key }); }
            }}
          />
        </label>
        <div className="session-confirm-actions">
          <Button className="session-confirm-cancel" onClick={() => answer(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => answer({ provider, key })}>Save</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Ask for one key in the window. Null is no answer, which every caller reads
 * as no: nothing is written, and nothing further is remembered.
 */
export function askForKey(request: KeyEntryRequest = {}): Promise<KeyEntryAnswer | null> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const answer = (result: KeyEntryAnswer | null): void => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(<KeyEntryDialog request={request} answer={answer} />);
  });
}
