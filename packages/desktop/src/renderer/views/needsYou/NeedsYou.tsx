import { useEffect, useMemo, useRef, useState } from 'react';
import type { Escalation, EscalationOption } from '@ordewell/core';
import type { HostToWebview } from '@ordewell/ui/protocol';
import type { FrameApi, Unregister } from '../../frame/api';
import { PLANNER_TAB } from '../../frame/layout';
import { useFrameState } from '../../frame/store';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { useSession } from '../../session/useSession';
import { all } from '../Stub';
import { startAttention } from './attention';
import { showEscalatedTask } from './escalationView';
import './needsYou.css';

/** The words a run-level item is listed under; a task names itself. */
const RUN_TITLES: Readonly<Record<string, string>> = {
  'merge-all': 'The run is waiting to be merged',
  'blocked-run': 'The run could not start',
};

const KIND_WORDS: Readonly<Record<Escalation['kind'], string>> = {
  approval: 'approval',
  checkpoint: 'checkpoint',
  input: 'input',
  conflict: 'conflict',
  'files-changed': 'files changed',
  'usage-limit': 'usage limit',
  failed: 'failed',
  'out-of-rounds': 'out of rounds',
  'merge-gate': 'merge gate',
  unapproved: 'not started',
  'on-hold': 'on hold',
  'no-prompt': 'no prompt',
  'by-hand': 'yours to do',
  'merge-all': 'merge all',
  'blocked-run': 'dirty checkout',
};

export type KindTone = 'attention' | 'failed' | 'blocked' | 'merge';

/**
 * The status colour a kind's word is drawn in. Every item here is a wait on
 * the user, but a failure or a merge is a different wait from an approval, and
 * the word says it only once the colour agrees with the rest of the app.
 */
export function kindTone(kind: Escalation['kind']): KindTone {
  switch (kind) {
    case 'failed':
    case 'out-of-rounds':
    case 'conflict':
      return 'failed';
    case 'blocked-run':
      return 'blocked';
    case 'merge-gate':
    case 'merge-all':
      return 'merge';
    default:
      return 'attention';
  }
}

function itemTitle(escalation: Escalation): string {
  if (escalation.task) return `${escalation.task.ref} ${escalation.task.title}`;
  return RUN_TITLES[escalation.kind] ?? 'This run';
}

interface Draft {
  escalationId: string;
  option: EscalationOption;
}

interface Refusal {
  key: number;
  title: string;
  message: string;
}

/**
 * What waits on the user (W7), from core's one derived list (ADR-0053). The
 * same component is the title bar's popover and the head of the Plan sidebar;
 * each answers inline with the same options a task's own card offers.
 */
function NeedsYouList({ api, host }: { api: FrameApi; host: DaemonHost }): JSX.Element {
  const { state, held, readOnly: heldElsewhere } = useSession(host);
  // The popover is drawn by the title bar, outside the body that goes inert while the daemon is away (W15), so it stops itself.
  const away = useFrameState().readOnly;
  const readOnly = heldElsewhere || away;
  const escalations = state.run.escalations ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(new Map());
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const requests = useRef(new Map<string, { escalation: Escalation; option: EscalationOption }>());
  const prefix = useRef(Math.random().toString(36).slice(2));
  const nextRequest = useRef(0);
  const nextRefusal = useRef(0);
  const bridge = useMemo(() => host.port('needs-you'), [host]);

  useEffect(() => {
    const onMessage = (msg: HostToWebview): void => {
      if (msg?.type !== 'escalationAnswered') return;
      const request = requests.current.get(msg.requestId);
      if (!request) return;
      requests.current.delete(msg.requestId);
      setSending((prev) => {
        const next = new Map(prev);
        next.delete(request.escalation.id);
        return next;
      });
      if (msg.ok) return;
      setRefusals((prev) => [...prev, {
        key: nextRefusal.current++,
        title: `${request.option.label}: ${itemTitle(request.escalation)}`,
        message: msg.message,
      }]);
    };
    return bridge.subscribe(onMessage);
  }, [bridge]);

  // A draft belongs to a wait that may end under it: nothing is left to answer then.
  useEffect(() => {
    if (draft && !escalations.some((e) => e.id === draft.escalationId)) setDraft(null);
  }, [escalations, draft]);

  const open = (escalation: Escalation): void => {
    if (escalation.task) showEscalatedTask(host, escalation.task.id, escalation.kind);
    else api.openTab(PLANNER_TAB);
  };

  const send = (escalation: Escalation, option: EscalationOption, text: string): void => {
    const requestId = `${prefix.current}-${nextRequest.current++}`;
    requests.current.set(requestId, { escalation, option });
    setSending((prev) => new Map(prev).set(escalation.id, option.label));
    setDraft(null);
    setNote('');
    void host.handle({
      type: 'answerEscalation',
      requestId,
      id: escalation.id,
      option: option.id,
      ...(text.trim() ? { note: text.trim() } : {}),
      ...(option.confirm ? { confirmed: true } : {}),
    });
  };

  const choose = (escalation: Escalation, option: EscalationOption): void => {
    if (option.confirm || option.note) {
      setNote('');
      setDraft({ escalationId: escalation.id, option });
      return;
    }
    send(escalation, option, '');
  };

  if (escalations.length === 0 && refusals.length === 0) {
    return <p className="frame-empty needs-empty">{heldElsewhere ? 'Another host holds this session, so its waits are not shown here.' : held ? 'Another host holds this session.' : 'Nothing needs you.'}</p>;
  }

  return (
    <div className="needs-list" aria-label="Waiting on you">
      <p className="needs-count" role="status">{escalations.length} {escalations.length === 1 ? 'item' : 'items'} waiting</p>
      {heldElsewhere && <p className="needs-hint">This session is open in another host: answer it there, or take it over from the banner.</p>}
      {refusals.map((refusal) => (
        <div key={refusal.key} className="needs-refusal" role="alert">
          <span><strong>Not done — {refusal.title}.</strong> {refusal.message}</span>
          <button type="button" onClick={() => setRefusals((prev) => prev.filter((r) => r.key !== refusal.key))}>Dismiss</button>
        </div>
      ))}
      <ul className="needs-items">
        {escalations.map((escalation) => {
          const busy = sending.get(escalation.id);
          const writing = draft?.escalationId === escalation.id ? draft.option : null;
          return (
            <li key={escalation.id} className="needs-item" aria-busy={busy !== undefined}>
              <div className="needs-item-head">
                <span className="needs-item-title" title={itemTitle(escalation)}>{itemTitle(escalation)}</span>
                <button type="button" className="needs-open" aria-label={`Open ${itemTitle(escalation)}`} onClick={() => open(escalation)}>Open</button>
              </div>
              <p className="needs-reason">
                <span className="needs-kind" data-tone={kindTone(escalation.kind)}>{KIND_WORDS[escalation.kind]}</span>
                {escalation.reason}
              </p>
              {busy !== undefined ? (
                <p className="needs-sending" role="status">Sending: {busy}…</p>
              ) : writing ? (
                <form
                  className="needs-form"
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setDraft(null); } }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (writing.note === 'required' && !note.trim()) return;
                    send(escalation, writing, note);
                  }}
                >
                  {writing.confirm && <p className="needs-confirm">{writing.confirm}</p>}
                  {writing.note && (
                    <label className="needs-note">
                      <span>{writing.note === 'required' ? 'Note (required)' : 'Note (optional)'}</span>
                      <textarea value={note} rows={2} autoFocus onChange={(e) => setNote(e.target.value)} />
                    </label>
                  )}
                  <span className="needs-actions">
                    <button type="submit" className="needs-primary" autoFocus={!writing.note} disabled={readOnly || (writing.note === 'required' && !note.trim())}>
                      {writing.confirm ? `Yes, ${writing.label}` : writing.label}
                    </button>
                    <button type="button" onClick={() => setDraft(null)}>Cancel</button>
                  </span>
                </form>
              ) : (
                <span className="needs-actions">
                  {escalation.options.map((option) => (
                    <button key={option.id} type="button" aria-label={`${option.label}: ${itemTitle(escalation)}`} disabled={readOnly} onClick={() => choose(escalation, option)}>
                      {option.label}
                    </button>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return all(
    api.registerSidebar({
      activity: 'sessions',
      id: 'needs-you',
      title: 'Needs you',
      order: 0,
      collapsible: true,
      count: () => (host.getSnapshot().state.run.escalations ?? []).length,
      render: () => <NeedsYouList api={api} host={host} /> }),
    api.registerSlot({ slot: 'popover.needsYou', id: 'needs-you', render: () => <NeedsYouList api={api} host={host} /> }),
    startAttention(api, host),
  );
}
