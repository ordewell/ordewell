import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react';
import type { DiscoveredModel } from '@ordewell/core';
import './allowlist.css';

/** Ticking several models sends one write, this long after the last tick. */
export const ALLOWLIST_DEBOUNCE_MS = 500;

/** How many labels the collapsed summary names before "+N". */
const SUMMARY_NAMES = 2;

interface Row {
  id: string;
  label: string;
  /** Allowed, but the runner's catalog no longer lists it. */
  unlisted: boolean;
}

const matches = (row: Row, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return !needle || row.label.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle);
};

/**
 * A runner's model allowlist (ADR-0003): the runner's full catalog with a
 * checkbox each, committed as one write once the ticking pauses or the picker
 * closes. An empty allowlist allows every model, so unticking the last one is
 * "All models" again, and `null` is how a write clears it. `models` is the
 * unfiltered catalog from `/api/models`; the allowlist only narrows what the
 * planner and the task pickers offer.
 */
export function ModelAllowlist({ runnerName, models, ids, disabled, onCommit }: {
  runnerName: string;
  models: readonly DiscoveredModel[];
  /** The allowlist the host holds. */
  ids: readonly string[] | undefined;
  disabled: boolean;
  /** Resolves once the host has answered; a refused write leaves `ids` as it was. */
  onCommit(ids: string[] | null): Promise<void> | void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Ticks not yet sent; `undefined` shows what the host holds.
  const [pending, setPending] = useState<string[] | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const pendingRef = useRef<string[] | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const searchId = useId();
  const hintId = useId();
  const optionPrefix = useId();

  const selected = pending ?? ids ?? [];
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const rows = useMemo((): Row[] => {
    const listed = new Set(models.map((model) => model.modelId));
    return [
      ...selected.filter((id) => !listed.has(id)).map((id): Row => ({ id, label: id, unlisted: true })),
      ...models.map((model): Row => ({ id: model.modelId, label: model.modelLabel || model.modelId, unlisted: false })),
    ];
  }, [models, selected]);
  const visible = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  const active = visible.find((row) => row.id === activeId) ?? visible[0];

  const flush = useCallback((): void => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const sent = pendingRef.current;
    if (!sent) return;
    // An empty list is how "no restriction" is written, as `null`.
    void Promise.resolve(commitRef.current(sent.length > 0 ? sent : null)).finally(() => {
      // Whatever the host answered stands: ticks made while it was answering stay shown.
      if (pendingRef.current === sent) {
        pendingRef.current = undefined;
        setPending(undefined);
      }
    });
  }, []);

  const change = (next: string[]): void => {
    pendingRef.current = next;
    setPending(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, ALLOWLIST_DEBOUNCE_MS);
  };

  const toggle = (id: string): void => {
    change(selectedSet.has(id) ? selected.filter((candidate) => candidate !== id) : [...selected, id]);
  };

  const allowAll = (): void => {
    pendingRef.current = [];
    setPending([]);
    flush();
  };

  const close = (): void => {
    flush();
    setOpen(false);
    toggleRef.current?.focus();
  };

  // What was ticked when this tab goes away is not lost.
  useEffect(() => () => { if (timer.current) flush(); }, [flush]);
  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (open && active) document.getElementById(`${optionPrefix}${active.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, optionPrefix]);

  const move = (to: number): void => {
    const row = visible[Math.max(0, Math.min(visible.length - 1, to))];
    if (row) setActiveId(row.id);
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = active ? visible.indexOf(active) : -1;
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') {
      if (at <= 0) searchRef.current?.focus();
      else move(at - 1);
    } else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(visible.length - 1);
    else if (event.key === ' ' || event.key === 'Enter') {
      if (active) toggle(active.id);
    } else return;
    event.preventDefault();
  };
  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const names = selected.map((id) => rows.find((row) => row.id === id)?.label ?? id);
  const summary = selected.length === 0
    ? 'All models'
    : `${selected.length} of ${rows.length} models: ${names.slice(0, SUMMARY_NAMES).join(', ')}${names.length > SUMMARY_NAMES ? `, +${names.length - SUMMARY_NAMES}` : ''}`;
  const count = selected.length === 0 ? `All ${rows.length} allowed` : `${selected.length} of ${rows.length} allowed`;

  return (
    <div className="allowlist">
      <span className="settings-label">{runnerName} models</span>
      <div className="allowlist-summary">
        <span className="allowlist-summary-text" title={summary}>{summary}</span>
        <button
          ref={toggleRef}
          type="button"
          className="allowlist-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Done editing' : 'Edit'} ${runnerName} models`}
          disabled={disabled}
          onClick={() => { if (open) close(); else setOpen(true); }}
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {open ? 'Done' : 'Edit'}
        </button>
      </div>
      {open && (
        <div id={panelId} className="allowlist-panel" role="group" aria-label={`${runnerName} model allowlist`} onKeyDown={onPanelKey}>
          <div className="allowlist-search">
            <input
              ref={searchRef}
              id={searchId}
              type="search"
              role="searchbox"
              aria-label={`Search ${runnerName} models`}
              placeholder="Search by name or id"
              value={query}
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); listRef.current?.focus(); }
              }}
            />
            {query && (
              <button type="button" className="allowlist-clear" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="allowlist-bar">
            <span className="allowlist-count" role="status">{count}</span>
            <button type="button" className="allowlist-all" disabled={disabled || selected.length === 0} onClick={allowAll}>Allow all models</button>
          </div>
          {visible.length === 0 ? (
            <p className="settings-hint allowlist-empty">
              {rows.length === 0 ? `${runnerName} lists no models.` : `No model matches “${query.trim()}”.`}
            </p>
          ) : (
            <div
              ref={listRef}
              className="allowlist-list"
              role="listbox"
              aria-multiselectable="true"
              aria-label={`${runnerName} models`}
              aria-describedby={hintId}
              aria-activedescendant={active ? `${optionPrefix}${active.id}` : undefined}
              aria-disabled={disabled}
              tabIndex={disabled ? -1 : 0}
              onKeyDown={onListKey}
            >
              {visible.map((row) => {
                const on = selectedSet.has(row.id);
                return (
                  <div
                    key={row.id}
                    id={`${optionPrefix}${row.id}`}
                    role="option"
                    aria-selected={on}
                    className={`allowlist-option${row === active ? ' is-active' : ''}`}
                    onMouseDown={(event) => { event.preventDefault(); listRef.current?.focus(); }}
                    onClick={() => { if (disabled) return; setActiveId(row.id); toggle(row.id); }}
                  >
                    <span className={`allowlist-box${on ? ' on' : ''}`} aria-hidden="true">{on && <Check size={12} />}</span>
                    <span className="allowlist-name">
                      <span className="allowlist-label">{row.label}</span>
                      <code className="allowlist-id">{row.id}</code>
                    </span>
                    {row.unlisted && <span className="allowlist-unlisted">Not listed by this runner</span>}
                  </div>
                );
              })}
            </div>
          )}
          <p id={hintId} className="settings-hint">
            Untick every model to allow all of them. A pick the allowlist rules out is replaced by the first model ticked.
          </p>
        </div>
      )}
    </div>
  );
}
