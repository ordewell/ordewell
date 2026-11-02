import { useEffect, useRef, useState } from 'react';
import type { ChildPlanEntry } from '@ordewell/core';
import type { HostToWebview, WebviewToHost } from '../../shared/protocol';
import type { ChildNotice } from './components/ChildPlanPanel';

interface ChildDraft {
  text: string;
  /** Out with the host until its result, with the title a failure will name. */
  sent?: { words: string; title: string };
}

type ChildDrafts = Readonly<Record<string, ChildDraft>>;

/** One child's message box, as its panel draws and drives it. */
export interface ChildComposer {
  text: string;
  sending: boolean;
  write: (text: string) => void;
  send: () => void;
}

/** A person may have typed on while the words were out: those stay. */
function settled(drafts: ChildDrafts, childId: string, words: string, landed: boolean): ChildDrafts {
  const { [childId]: draft, ...others } = drafts;
  if (!draft) return drafts;
  return landed && draft.text === words ? others : { ...others, [childId]: { text: draft.text } };
}

/**
 * A person's words to each child, kept above the panels: a panel is keyed by
 * session, so a nested open unmounts it, and a result can come back to a panel
 * that has gone. Words leave only when they land, so a refusal finds them.
 */
export function useChildDrafts(post: (message: WebviewToHost) => void, notify: (notice: ChildNotice) => void): (child: ChildPlanEntry) => ChildComposer {
  const [drafts, setDrafts] = useState<ChildDrafts>({});
  const latest = useRef(drafts);
  latest.current = drafts;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type !== 'childMessageResult') return;
      const sent = latest.current[msg.childId]?.sent;
      if (!sent) return;
      setDrafts((current) => settled(current, msg.childId, sent.words, !msg.error));
      // The view of wherever the person went may still be on its way, so a
      // failure belongs to no panel, and names the child to read right in any.
      notify(msg.error
        ? { childId: '', message: `Not sent to ${sent.title}: ${msg.error}` }
        : { childId: msg.childId, message: msg.status === 'queued' ? 'Message queued.' : 'Message sent.' });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [notify]);

  return (child) => {
    const childId = child.sessionId;
    const draft = drafts[childId];
    return {
      text: draft?.text ?? '',
      sending: draft?.sent !== undefined,
      write: (text) => setDrafts((current) => ({ ...current, [childId]: { ...current[childId], text } })),
      send: () => {
        const { text, sent } = latest.current[childId] ?? { text: '' };
        if (!text.trim() || sent) return;
        setDrafts((current) => ({ ...current, [childId]: { text, sent: { words: text, title: child.title } } }));
        post({ type: 'messageChild', childId, text });
      },
    };
  };
}

/** What a person has typed into one question's form, whether or not it was ever sent. */
export interface AnswerDraft {
  /** An approval's words, for a delegated task. */
  words: string;
  /** A rejection's reason. */
  reason: string;
  /** Whether the rejection form is the one open. */
  rejecting: boolean;
}

export const EMPTY_ANSWER_DRAFT: AnswerDraft = { words: '', reason: '', rejecting: false };

/** An answer the host refused, still the person's to read, edit and send again. */
export interface Undelivered {
  taskId: string;
  question: string;
  draft: AnswerDraft;
  error: string;
}

/** One child's checkpoints, as its panel draws and drives them. */
export interface ChildAnswers {
  /** Whether an answer on this task is out with the host. */
  out: (taskId: string) => boolean;
  /** What is typed to this very question, however many times the panel has come and gone. */
  draft: (taskId: string, question: string) => AnswerDraft;
  edit: (taskId: string, question: string, draft: AnswerDraft) => void;
  give: (taskId: string, given: { question: string; answer: 'approve' | 'reject'; words?: string }) => void;
  /** The refused answers whose question is not one the panel still offers a form for. */
  undelivered: (offered: (taskId: string, question: string) => boolean) => Undelivered[];
  dismiss: (taskId: string, question: string) => void;
}

/**
 * Keyed by the question as well as the task: an answer belongs to the question
 * it was given to, so a later question cannot overwrite or inherit it.
 */
interface KeptAnswer {
  childId: string;
  taskId: string;
  question: string;
  /** For the failure to name. */
  title: string;
  draft: AnswerDraft;
  /** Typed only; out with the host until its result; or refused by it. */
  state: 'draft' | 'out' | 'refused';
  error?: string;
}

const answerKey = (childId: string, taskId: string, question: string): string => JSON.stringify([childId, taskId, question]);

/**
 * A person's answers, kept above the panels for the reason their messages are:
 * a refusal can come back to a panel that has gone, and to a question that has
 * gone with it. A refused answer leaves only when the person lets it go or it
 * is sent again and lands; what is typed into its form is kept as they type.
 */
export function useChildAnswers(post: (message: WebviewToHost) => void, notify: (notice: ChildNotice) => void): (child: ChildPlanEntry) => ChildAnswers {
  const [answers, setAnswers] = useState<Readonly<Record<string, KeptAnswer>>>({});
  const latest = useRef(answers);
  latest.current = answers;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type !== 'childControlResult') return;
      // A result names no question, but a task has one answer out at a time.
      const key = Object.keys(latest.current).find((k) => {
        const kept = latest.current[k];
        return kept.state === 'out' && kept.childId === msg.childId && kept.taskId === msg.taskId;
      });
      if (!key) return;
      const kept = latest.current[key];
      setAnswers(({ [key]: _settled, ...others }) => (msg.error ? { ...others, [key]: { ...kept, state: 'refused', error: msg.error } } : others));
      // As for a message: the view of wherever the person went may still be on its way.
      if (msg.error) notify({ childId: '', message: `Not answered in ${kept.title}: ${msg.error}` });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [notify]);

  return ({ sessionId: childId, title }) => ({
    out: (taskId) => Object.values(answers).some((kept) => kept.state === 'out' && kept.childId === childId && kept.taskId === taskId),
    draft: (taskId, question) => answers[answerKey(childId, taskId, question)]?.draft ?? EMPTY_ANSWER_DRAFT,
    edit: (taskId, question, draft) => setAnswers((current) => {
      const key = answerKey(childId, taskId, question);
      return { ...current, [key]: { ...(current[key] ?? { childId, taskId, question, state: 'draft' as const }), title, draft } };
    }),
    give: (taskId, { question, answer, words }) => {
      const key = answerKey(childId, taskId, question);
      setAnswers((current) => {
        const kept = current[key];
        return { ...current, [key]: { childId, taskId, question, draft: EMPTY_ANSWER_DRAFT, ...kept, title, state: 'out' as const, error: undefined } };
      });
      post({ type: 'answerChildCheckpoint', childId, taskId, question, answer, ...(words ? { reason: words } : {}) });
    },
    undelivered: (offered) => Object.values(answers)
      .filter((kept) => kept.childId === childId && kept.state === 'refused' && (kept.draft.words.trim() || kept.draft.reason.trim()) && !offered(kept.taskId, kept.question))
      .map(({ taskId, question, draft, error }) => ({ taskId, question, draft, error: error ?? '' })),
    dismiss: (taskId, question) => setAnswers(({ [answerKey(childId, taskId, question)]: _gone, ...others }) => others),
  });
}
