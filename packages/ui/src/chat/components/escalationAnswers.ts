import { useCallback, useEffect, useRef, useState } from 'react';
import type { Escalation, EscalationOption } from '@ordewell/core';
import type { EscalationAnswer, HostToWebview } from '../../shared/protocol';
import { useChatBridge } from '../../bridge';

/** A refusal is kept apart from the list: a stale entry has left it by the time the host says so. */
export interface Refusal {
  key: number;
  title: string;
  message: string;
}

export const taskLabel = (e: Escalation): string => (e.task ? `${e.task.ref} ${e.task.title}` : 'This run');

export interface EscalationAnswers {
  /** The option each escalation's answer in flight was, by escalation id. */
  sending: ReadonlyMap<string, string>;
  refusals: readonly Refusal[];
  answer(escalation: Escalation, option: EscalationOption, text: string, confirmed: boolean): void;
  dismiss(key: number): void;
}

/**
 * The answers in flight and the host's refusals (ADR-0053), held above the
 * inbox's control so a refusal that outlives its entry still has a control to
 * show it from. The list itself is the host's, replaced whole on every update.
 */
export function useEscalationAnswers(send: (answer: EscalationAnswer) => void): EscalationAnswers {
  const bridge = useChatBridge();
  const [sending, setSending] = useState<ReadonlyMap<string, string>>(new Map());
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const requests = useRef(new Map<string, { escalation: Escalation; option: EscalationOption }>());
  // Prefixed per page: a reload starts the count again, and an answer still on its way to the old page must not match.
  const prefix = useRef(Math.random().toString(36).slice(2));
  const nextRequest = useRef(0);
  const nextRefusal = useRef(0);

  useEffect(() => {
    const onMessage = (msg: HostToWebview) => {
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
        title: `${request.option.label}: ${taskLabel(request.escalation)}`,
        message: msg.message,
      }]);
    };
    return bridge.subscribe(onMessage);
  }, [bridge]);

  const answer = useCallback((escalation: Escalation, option: EscalationOption, text: string, confirmed: boolean) => {
    const requestId = `${prefix.current}-${nextRequest.current++}`;
    requests.current.set(requestId, { escalation, option });
    setSending((prev) => new Map(prev).set(escalation.id, option.label));
    send({ requestId, id: escalation.id, option: option.id, ...(text.trim() ? { note: text.trim() } : {}), ...(confirmed ? { confirmed: true } : {}) });
  }, [send]);

  const dismiss = useCallback((key: number) => setRefusals((prev) => prev.filter((r) => r.key !== key)), []);

  return { sending, refusals, answer, dismiss };
}
