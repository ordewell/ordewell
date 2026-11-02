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

/** A person's answer to one question, as its form takes it back. */
export interface GivenAnswer {
  question: string;
  answer: 'approve' | 'reject';
  words?: string;
}

/** One child's checkpoints, as its panel draws and drives them. */
export interface ChildAnswers {
  /** Whether an answer on this task is out with the host. */
  out: (taskId: string) => boolean;
  /** What this very question was last answered with, until that lands. */
  given: (taskId: string, question: string) => GivenAnswer | undefined;
  give: (taskId: string, given: GivenAnswer) => void;
}

/** Out with the host until its result, with the title a failure will name. */
type KeptAnswer = GivenAnswer & { title: string; out: boolean };

const answerKey = (childId: string, taskId: string): string => JSON.stringify([childId, taskId]);

/**
 * A person's answers, kept above the panels for the reason their messages are:
 * a refusal can come back to a panel that has gone. An answer leaves only when
 * it lands, so the form that comes back finds its words.
 */
export function useChildAnswers(post: (message: WebviewToHost) => void, notify: (notice: ChildNotice) => void): (child: ChildPlanEntry) => ChildAnswers {
  const [answers, setAnswers] = useState<Readonly<Record<string, KeptAnswer>>>({});
  const latest = useRef(answers);
  latest.current = answers;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type !== 'childControlResult') return;
      const key = answerKey(msg.childId, msg.taskId);
      const kept = latest.current[key];
      if (!kept) return;
      setAnswers(({ [key]: _settled, ...others }) => (msg.error ? { ...others, [key]: { ...kept, out: false } } : others));
      // As for a message: the view of wherever the person went may still be on its way.
      if (msg.error) notify({ childId: '', message: `Not answered in ${kept.title}: ${msg.error}` });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [notify]);

  return ({ sessionId: childId, title }) => ({
    out: (taskId) => answers[answerKey(childId, taskId)]?.out === true,
    given: (taskId, question) => {
      const kept = answers[answerKey(childId, taskId)];
      return kept?.question === question ? kept : undefined;
    },
    give: (taskId, given) => {
      setAnswers((current) => ({ ...current, [answerKey(childId, taskId)]: { ...given, title, out: true } }));
      const { question, answer, words } = given;
      post({ type: 'answerChildCheckpoint', childId, taskId, question, answer, ...(words ? { reason: words } : {}) });
    },
  });
}
