import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@ordewell/ui/design';
import type { AiProvider } from '@ordewell/core';
import { endpointUrlProblem, isProviderRunner, PROVIDER_PRIORITY, VENDORS } from '@ordewell/core/plan-utils';
import './confirm.css';

/**
 * The key entry (ADR-0052): one vendor, one secret. The key never leaves this
 * dialog's own state until it is resolved to the caller, which writes it
 * through the daemon and drops it (ADR-0061). Custom is set up by its
 * endpoint instead, so it asks for that URL, and its key is optional.
 */
export interface KeyEntryRequest {
  /** The vendor a runner's key route names; absent asks which vendor. */
  provider?: AiProvider;
  /** The agent this key signs in, so the person knows what they are configuring. */
  runnerLabel?: string;
}

export interface KeyEntryAnswer {
  provider: AiProvider;
  /** Empty only for Custom, whose endpoint may take no key. */
  key: string;
  /** Custom's endpoint, which is what sets it up. */
  baseUrl?: string;
}

/** The provider whose endpoint, not a key, is what sets it up: a local server takes no key. */
const CUSTOM: AiProvider = 'openai_compatible';

interface DialogProps {
  request: KeyEntryRequest;
  answer(result: KeyEntryAnswer | null): void;
}

/**
 * The settings write an answer is, the one every key entry of the app sends.
 * Custom's key is sent even empty: an empty one takes the key saved before
 * away, which the endpoint just set must not be sent (`removesCredential`).
 */
export function keyEntryEnv(answer: KeyEntryAnswer): Record<string, string> {
  const meta = VENDORS[answer.provider];
  if (answer.baseUrl !== undefined && meta.baseUrlEnvVar) return { [meta.baseUrlEnvVar]: answer.baseUrl, [meta.apiKeyEnvVar]: answer.key };
  return answer.key ? { [meta.apiKeyEnvVar]: answer.key } : {};
}

const listed = (saved: unknown, field: string): unknown[] => {
  const value = typeof saved === 'object' && saved !== null ? Reflect.get(saved, field) : undefined;
  return Array.isArray(value) ? value : [];
};

/** Why the daemon's answer to {@link keyEntryEnv}'s write is no save (`rejectedEnvKeys`), or undefined when it took it. */
export function keyEntryRefusal(saved: unknown, provider: AiProvider): string | undefined {
  const rejected = listed(saved, 'rejectedEnvKeys');
  const meta = VENDORS[provider];
  if (rejected.includes(meta.apiKeyEnvVar)) return `The daemon refused the ${meta.label} key.`;
  if (meta.baseUrlEnvVar && rejected.includes(meta.baseUrlEnvVar)) return `The daemon refused the ${meta.label} endpoint.`;
  return undefined;
}

/**
 * What to tell the person when the daemon took a key it could not save
 * (`unsavedEnvKeys`): the desktop app has no file of its own, so the key
 * lasts as long as that daemon does. Undefined when it was saved. Custom's
 * endpoint is named first: its key may be one the write only took away.
 */
export function unsavedKeyWarning(saved: unknown, provider: AiProvider): string | undefined {
  const unsaved = listed(saved, 'unsavedEnvKeys');
  const meta = VENDORS[provider];
  const what = meta.baseUrlEnvVar && unsaved.includes(meta.baseUrlEnvVar) ? 'endpoint' : unsaved.includes(meta.apiKeyEnvVar) ? 'key' : undefined;
  if (!what) return undefined;
  return `The ${meta.label} ${what} is in use, but it could not be saved to ~/.ordewell/.env: once Ordewell restarts, set it again.`;
}

/** One provider's name, as core words it. */
function providerName(provider: AiProvider): string {
  return VENDORS[provider].label;
}

/** A provider in the list, marked when its key adds no built-in runner: it lists no models to run tasks on. */
function providerChoice(provider: AiProvider): string {
  return isProviderRunner(provider) ? providerName(provider) : `${providerName(provider)} (planner only)`;
}

export function KeyEntryDialog({ request, answer }: DialogProps): JSX.Element {
  const [provider, setProvider] = useState<AiProvider>(request.provider ?? PROVIDER_PRIORITY[0]);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const urlProblemId = useId();
  const meta = VENDORS[provider];
  const custom = provider === CUSTOM;
  const urlProblem = endpointUrlProblem(baseUrl);
  const ready = custom ? urlProblem === undefined : key.trim() !== '';
  const answerOf = (): KeyEntryAnswer => (custom ? { provider, key: key.trim(), baseUrl: baseUrl.trim() } : { provider, key });
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && ready) { event.preventDefault(); answer(answerOf()); }
  };
  // A key typed for one vendor is never saved as another's.
  const chooseProvider = (next: AiProvider): void => {
    setProvider(next);
    setKey('');
  };

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
        <p id={titleId} className="session-confirm-message">{custom ? 'Endpoint' : 'API key'} for {providerName(provider)}</p>
        <p id={hintId} className="session-confirm-detail">
          {custom
            ? <>Ordewell reaches it at this URL, stored as <code>{meta.baseUrlEnvVar}</code>. A key, if it takes one, is stored as <code>{meta.apiKeyEnvVar}</code> and never shown again; left empty, a key saved before is removed.</>
            : request.runnerLabel
              ? <>Ordewell hands this key to {request.runnerLabel}. It is stored as <code>{meta.apiKeyEnvVar}</code> and never shown again.</>
              : <>Ordewell uses it as <code>{meta.apiKeyEnvVar}</code>, and never shows it again.</>}
        </p>
        {request.provider === undefined && (
          <label className="key-entry-field">
            <span>Provider</span>
            <select className="ow-select" value={provider} onChange={(event) => chooseProvider(event.target.value as AiProvider)} aria-label="Provider">
              {PROVIDER_PRIORITY.map((id) => <option key={id} value={id}>{providerChoice(id)}</option>)}
            </select>
          </label>
        )}
        {custom && (
          <label className="key-entry-field">
            <span>Endpoint URL</span>
            <input
              ref={request.provider === CUSTOM ? field : undefined}
              type="url"
              className="key-entry-input"
              aria-label="Endpoint URL"
              placeholder={meta.defaultBaseUrl}
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              onKeyDown={submitOnEnter}
              aria-invalid={baseUrl.trim() !== '' && urlProblem !== undefined}
              {...(baseUrl.trim() !== '' && urlProblem ? { 'aria-describedby': urlProblemId } : {})}
            />
            {/* Said only once something is typed: an empty field needs no telling off. */}
            {baseUrl.trim() !== '' && urlProblem && <span id={urlProblemId} className="key-entry-problem" role="status">{urlProblem}</span>}
          </label>
        )}
        <label className="key-entry-field">
          <span>{custom ? 'API key (optional)' : 'API key'}</span>
          <input
            ref={request.provider === CUSTOM ? undefined : field}
            type="password"
            className="key-entry-input"
            aria-label="API key"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={submitOnEnter}
          />
        </label>
        <div className="session-confirm-actions">
          <Button className="session-confirm-cancel" onClick={() => answer(null)}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => answer(answerOf())}>Save</Button>
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
