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
  /** A raise of the budget, as typed; only the root's card offers one (ADR-0055 D20). */
  raise?: string;
}

export const EMPTY_ANSWER_DRAFT: AnswerDraft = { words: '', reason: '', rejecting: false };

/** The two texts a form holds: an approval's words and a rejection's reason. */
type Field = 'words' | 'reason';

/** One question's words as the list shows them. */
export interface UndeliveredWords {
  field: Field;
  text: string;
}

/**
 * What the form of a question that has no form to return to still holds: the
 * words that were sent and refused, and the words only typed. They are told
 * apart because a person reading "your rejection reason" must be able to trust
 * that it went to the host.
 */
export interface Undelivered {
  childId: string;
  /** For a list that names whose it is. */
  title: string;
  taskId: string;
  question: string;
  /** Sent, as the form now has them, with the host's refusal. */
  refused?: { words: UndeliveredWords[]; error: string };
  /** Typed into the form and never sent. */
  unsent?: UndeliveredWords[];
}

/** Which of the two lists a person lets go of. */
export type UndeliveredPart = 'refused' | 'unsent';

/** One child's checkpoints, as its panel draws and drives them. */
export interface ChildAnswers {
  /** Whether an answer on this task is out with the host. */
  out: (taskId: string) => boolean;
  /** What is typed to this very question, however many times the panel has come and gone. */
  draft: (taskId: string, question: string) => AnswerDraft;
  edit: (taskId: string, question: string, draft: AnswerDraft) => void;
  give: (taskId: string, given: { question: string; answer: 'approve' | 'reject'; words?: string; raiseTokens?: number }) => void;
  /** What is left of the questions the panel does not still offer a form for. */
  undelivered: (offered: (taskId: string, question: string) => boolean) => Undelivered[];
  dismiss: (taskId: string, question: string, part: UndeliveredPart) => void;
}

/** Whose answers the root plan's own checkpoint card keeps: not a child's session id. */
export const ROOT_ANSWERS = '@root';

/** Where the root view looks: which children it can still open, and which question its card offers. */
export interface RootView {
  inTree: (childId: string) => boolean;
  offered: (taskId: string, question: string) => boolean;
}

/** The answers kept for the root card and for every child, for a place that is not one child's panel. */
export interface KeptAnswers {
  of: (child: Pick<ChildPlanEntry, 'sessionId' | 'title'>) => ChildAnswers;
  /**
   * What the root view lists: every refused answer, whatever has become of its
   * question, and the words only typed that no form can show any more: the
   * root's own once its card has moved on, and a child's once its tree has
   * dropped it.
   */
  stranded: (view: RootView) => Undelivered[];
  dismiss: (item: Undelivered, part: UndeliveredPart) => void;
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
  /** What the form holds now. */
  draft: AnswerDraft;
  /**
   * The words that went to the host, as sent: the form may have been edited
   * since, and the list must say what the host refused, not what was typed after.
   */
  sent: Readonly<Partial<Record<Field, string>>>;
  /**
   * The form as it stood when the answer went, for the root card, which closes
   * on answering: a refusal brings it back to this, unless the question was
   * asked again and typed into meanwhile.
   */
  given?: AnswerDraft;
  /** Typed only; out with the host until its result; or refused by it. */
  state: 'draft' | 'out' | 'refused';
  error?: string;
}

const answerKey = (childId: string, taskId: string, question: string): string => JSON.stringify([childId, taskId, question]);
const FIELDS: readonly Field[] = ['words', 'reason'];

const blank = (draft: AnswerDraft): boolean => draft.words.trim() === '' && draft.reason.trim() === '' && !draft.rejecting && !(draft.raise ?? '').trim();

/** The words a form holds that were not what went to the host. */
const typedAfter = (kept: KeptAnswer, field: Field): boolean => {
  const text = kept.draft[field].trim();
  return text !== '' && text !== kept.sent[field];
};

function listed(kept: KeptAnswer): Undelivered | undefined {
  const { childId, title, taskId, question } = kept;
  const refused = kept.state === 'refused'
    ? FIELDS.flatMap((field) => { const text = kept.sent[field]; return text ? [{ field, text }] : []; })
    : [];
  const unsent = FIELDS.filter((field) => typedAfter(kept, field)).map((field) => ({ field, text: kept.draft[field] }));
  if (refused.length === 0 && unsent.length === 0) return undefined;
  return { childId, title, taskId, question, ...(refused.length > 0 ? { refused: { words: refused, error: kept.error ?? '' } } : {}), ...(unsent.length > 0 ? { unsent } : {}) };
}

/** What stays of a kept answer when a person lets go of one of its two lists, if anything does. */
function letGo(kept: KeptAnswer, part: UndeliveredPart): KeptAnswer | undefined {
  // The form still holding what was refused goes with it; words typed after it are the other list's.
  const goes = (field: Field) => part === 'refused'
    ? kept.sent[field] !== undefined && !typedAfter(kept, field)
    : typedAfter(kept, field);
  const draft = { ...kept.draft, ...Object.fromEntries(FIELDS.filter(goes).map((field) => [field, ''])) };
  const sent = part === 'refused' ? {} : kept.sent;
  if (Object.keys(sent).length === 0 && draft.words.trim() === '' && draft.reason.trim() === '') return undefined;
  return { ...kept, draft, sent, state: part === 'refused' ? 'draft' : kept.state, error: part === 'refused' ? undefined : kept.error };
}

/** The host refused: the card or form comes back to the words it was answered with. */
function refuse(kept: KeptAnswer, error: string): KeptAnswer {
  return { ...kept, state: 'refused', error, draft: kept.given && blank(kept.draft) ? kept.given : kept.draft, given: undefined };
}

/**
 * A person's answers, kept above the panels for the reason their messages are:
 * a refusal can come back to a panel that has gone, and to a question that has
 * gone with it. A refused answer leaves only when the person lets it go or it
 * is sent again and lands; what is typed into its form is kept as they type,
 * and told apart from what was sent.
 */
export function useChildAnswers(post: (message: WebviewToHost) => void, notify: (notice: ChildNotice) => void): KeptAnswers {
  const [answers, setAnswers] = useState<Readonly<Record<string, KeptAnswer>>>({});
  const latest = useRef(answers);
  latest.current = answers;

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type === 'checkpointRefused') {
        // The root's host names the question, so a late refusal cannot land on a newer one.
        const key = answerKey(ROOT_ANSWERS, msg.taskId, msg.question);
        if (latest.current[key]?.state !== 'out') return;
        setAnswers((current) => (current[key]?.state === 'out' ? { ...current, [key]: refuse(current[key], msg.error) } : current));
        return;
      }
      if (msg.type !== 'childControlResult') return;
      // A result names no question, but a task has one answer out at a time.
      const key = Object.keys(latest.current).find((k) => {
        const kept = latest.current[k];
        return kept.state === 'out' && kept.childId === msg.childId && kept.taskId === msg.taskId;
      });
      if (!key) return;
      const kept = latest.current[key];
      setAnswers(({ [key]: _settled, ...others }) => (msg.error ? { ...others, [key]: refuse(kept, msg.error) } : others));
      // As for a message: the view of wherever the person went may still be on its way.
      if (msg.error) notify({ childId: '', message: `Not answered in ${kept.title}: ${msg.error}` });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [notify]);

  const discard = (childId: string, taskId: string, question: string, part: UndeliveredPart) => setAnswers((current) => {
    const key = answerKey(childId, taskId, question);
    const { [key]: kept, ...others } = current;
    const left = kept && letGo(kept, part);
    return left ? { ...others, [key]: left } : others;
  });

  return {
    stranded: ({ inTree, offered }) => Object.values(answers).flatMap((kept) => {
      const root = kept.childId === ROOT_ANSWERS;
      // The card shows what its own question holds.
      if (root && offered(kept.taskId, kept.question)) return [];
      const item = listed(kept);
      if (!item) return [];
      // A child still in the tree has a panel to read the words only typed in.
      const unsent = root || !inTree(kept.childId) ? item.unsent : undefined;
      return item.refused || unsent ? [{ ...item, unsent }] : [];
    }),
    dismiss: (item, part) => discard(item.childId, item.taskId, item.question, part),
    of: ({ sessionId: childId, title }) => ({
      out: (taskId) => Object.values(answers).some((kept) => kept.state === 'out' && kept.childId === childId && kept.taskId === taskId),
      draft: (taskId, question) => answers[answerKey(childId, taskId, question)]?.draft ?? EMPTY_ANSWER_DRAFT,
      edit: (taskId, question, draft) => setAnswers((current) => {
        const key = answerKey(childId, taskId, question);
        const kept = current[key] ?? { childId, taskId, question, sent: {}, state: 'draft' as const };
        // Clearing a refused field is letting it go; any other edit leaves what was sent as it was.
        const cleared = (field: Field) => kept.state === 'refused' && kept.draft[field].trim() !== '' && draft[field].trim() === '';
        const sent = Object.fromEntries(Object.entries(kept.sent).filter(([field]) => !cleared(field as Field)));
        return { ...current, [key]: { ...kept, title, draft, sent } };
      }),
      give: (taskId, { question, answer, words, raiseTokens }) => {
        const key = answerKey(childId, taskId, question);
        const root = childId === ROOT_ANSWERS;
        setAnswers((current) => {
          const kept = current[key];
          const field: Field = answer === 'approve' ? 'words' : 'reason';
          // A wordless approval sent no words, so none are its to show.
          const sent = words?.trim() ? { ...kept?.sent, [field]: words.trim() } : (kept?.sent ?? {});
          const form = kept?.draft ?? EMPTY_ANSWER_DRAFT;
          // The root's card closes, so a question asked again finds its form blank.
          return { ...current, [key]: { childId, taskId, question, ...kept, title, draft: root ? EMPTY_ANSWER_DRAFT : form, given: root ? form : undefined, sent, state: 'out' as const, error: undefined } };
        });
        post(root
          ? { type: 'answerCheckpoint', taskId, question, approved: answer === 'approve', ...(words ? { reason: words } : {}), ...(raiseTokens !== undefined ? { raiseTokens } : {}) }
          : { type: 'answerChildCheckpoint', childId, taskId, question, answer, ...(words ? { reason: words } : {}) });
      },
      undelivered: (offered) => Object.values(answers)
        .filter((kept) => kept.childId === childId && !offered(kept.taskId, kept.question))
        .map(listed)
        .filter((item): item is Undelivered => item !== undefined),
      dismiss: (taskId, question, part) => discard(childId, taskId, question, part),
    }),
  };
}
