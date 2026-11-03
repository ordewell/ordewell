import { useCallback, useEffect, useRef, useState } from 'react';
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

/** The texts a form holds: an approval's words, a rejection's reason, and a raise. */
type Field = 'words' | 'reason' | 'raise';

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
  /** Sends the answer, and returns the identity the host's result will name. */
  give: (taskId: string, given: { question: string; answer: 'approve' | 'reject'; words?: string; raiseTokens?: number }) => string;
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
 * One answer given. It has an identity of its own because a question can be
 * asked again word for word while this answer is out: only the id says which
 * answer the host's result speaks for. An answer that lands leaves the list, so
 * nothing here was ever delivered.
 */
interface Delivery {
  id: string;
  /**
   * The words that went to the host, as sent: the form may have been edited
   * since, and the list must say what the host refused, not what was typed after.
   */
  sent: Readonly<Partial<Record<Field, string>>>;
  /** The form as it stood when the answer went, which a refusal brings back to the root's card, closed on answering. */
  given: AnswerDraft;
  /** The host's refusal; none while the answer is out. */
  error?: string;
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
  /** The answers to this question the host has not taken, oldest first. */
  deliveries: readonly Delivery[];
}

type Answers = Readonly<Record<string, KeptAnswer>>;

const answerKey = (childId: string, taskId: string, question: string): string => JSON.stringify([childId, taskId, question]);
const FIELDS: readonly Field[] = ['words', 'reason', 'raise'];

const typed = (draft: AnswerDraft, field: Field): string => (draft[field] ?? '').trim();

const blank = (draft: AnswerDraft): boolean => !draft.rejecting && FIELDS.every((field) => typed(draft, field) === '');

const isOut = (delivery: Delivery): boolean => delivery.error === undefined;

/** The refusals that stand: one a later answer may yet replace is not the person's to act on until that answer is settled. */
function refusals({ deliveries }: KeptAnswer): readonly Delivery[] {
  let from = deliveries.length;
  while (from > 0 && !isOut(deliveries[from - 1])) from--;
  return deliveries.slice(from);
}

/** What the standing refusals sent, field by field: a later answer's words replace an earlier's. */
const refusedWords = (kept: KeptAnswer): Delivery['sent'] => Object.assign({}, ...refusals(kept).map((delivery) => delivery.sent));

/**
 * The words a form holds that are not what went to the host. Only what is out or
 * listed as refused counts: an older refusal a later answer has replaced is shown
 * nowhere, so words equal to it are the person's own, typed again.
 */
const typedAfter = (kept: KeptAnswer, field: Field): boolean => {
  const text = typed(kept.draft, field);
  const shown = refusedWords(kept)[field];
  return text !== '' && shown !== text && !kept.deliveries.some((delivery) => isOut(delivery) && delivery.sent[field] === text);
};

function listed(kept: KeptAnswer): Undelivered | undefined {
  const { childId, title, taskId, question } = kept;
  const sent = refusedWords(kept);
  const refused = FIELDS.flatMap((field) => { const text = sent[field]; return text ? [{ field, text }] : []; });
  const unsent = FIELDS.filter((field) => typedAfter(kept, field)).map((field) => ({ field, text: kept.draft[field] ?? '' }));
  if (refused.length === 0 && unsent.length === 0) return undefined;
  return { childId, title, taskId, question, ...(refused.length > 0 ? { refused: { words: refused, error: refusals(kept).at(-1)?.error ?? '' } } : {}), ...(unsent.length > 0 ? { unsent } : {}) };
}

/** What stays of a kept answer when a person lets go of one of its two lists, if anything does. */
function letGo(kept: KeptAnswer, part: UndeliveredPart): KeptAnswer | undefined {
  const sent = refusedWords(kept);
  const shown = refusals(kept);
  // The form still holding what was refused goes with it; words typed after it are the other list's.
  const goes = (field: Field) => part === 'refused'
    ? sent[field] !== undefined && !typedAfter(kept, field)
    : typedAfter(kept, field);
  const draft = { ...kept.draft, ...Object.fromEntries(FIELDS.filter(goes).map((field) => [field, ''])) };
  const deliveries = part === 'refused' ? kept.deliveries.filter((delivery) => !shown.includes(delivery)) : kept.deliveries;
  if (deliveries.length === 0 && FIELDS.every((field) => typed(draft, field) === '')) return undefined;
  return { ...kept, draft, deliveries };
}

/** The host refused: the card or form comes back to the newest answer's words, and an older one's are not put over them. */
function refuse(kept: KeptAnswer, id: string, error: string): KeptAnswer {
  const newest = kept.deliveries.at(-1);
  return {
    ...kept,
    deliveries: kept.deliveries.map((delivery) => (delivery.id === id ? { ...delivery, error } : delivery)),
    draft: newest?.id === id && blank(kept.draft) ? newest.given : kept.draft,
  };
}

/**
 * The host took the answer, which settles every older one to this question,
 * whatever the host said or has yet to say of it: results can come in any order
 * and must leave the same list. A newer answer has its own result to come.
 */
function land(kept: KeptAnswer, id: string): KeptAnswer | undefined {
  const index = kept.deliveries.findIndex((delivery) => delivery.id === id);
  const deliveries = kept.deliveries.slice(index + 1);
  // The same object: the form is as this answer took it. Equal words in another are retyped, and new.
  const draft = kept.draft === kept.deliveries[index].given ? EMPTY_ANSWER_DRAFT : kept.draft;
  return deliveries.length === 0 && blank(draft) ? undefined : { ...kept, draft, deliveries };
}

/**
 * A person's answers, kept above the panels for the reason their messages are:
 * a refusal can come back to a panel that has gone, and to a question that has
 * gone with it. A refused answer leaves only when the person lets it go or it
 * is sent again and lands; what is typed into its form is kept as they type,
 * and told apart from what was sent.
 */
export function useChildAnswers(post: (message: WebviewToHost) => void, notify: (notice: ChildNotice) => void): KeptAnswers {
  const [answers, setAnswers] = useState<Answers>({});
  // Written at once, not on render: a result can come before the render of the answer it names, and another result right after it.
  const latest = useRef(answers);
  const change = useCallback((next: (current: Answers) => Answers) => {
    latest.current = next(latest.current);
    setAnswers(latest.current);
  }, []);
  // Prefixed per page, as an escalation's request is: a result on its way to the old page must not match a new count.
  const page = useRef(Math.random().toString(36).slice(2));
  const nextAnswer = useRef(0);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebview>) => {
      const msg = event.data;
      if (msg.type !== 'checkpointResult') return;
      const { answerId, error } = msg;
      // An answer a later one has settled is gone, and so is the last word on it.
      const key = Object.keys(latest.current).find((k) => latest.current[k].deliveries.some((delivery) => delivery.id === answerId));
      if (!key) return;
      const kept = latest.current[key];
      const left = error === undefined ? land(kept, answerId) : refuse(kept, answerId, error);
      change(({ [key]: _settled, ...others }) => (left ? { ...others, [key]: left } : others));
      // As for a message: the view of wherever the person went may still be on
      // its way. The root's refusal has its card to come back to.
      if (error !== undefined && kept.childId !== ROOT_ANSWERS) notify({ childId: '', message: `Not answered in ${kept.title}: ${error}` });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [change, notify]);

  const discard = (childId: string, taskId: string, question: string, part: UndeliveredPart) => change((current) => {
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
      out: (taskId) => Object.values(answers).some((kept) => kept.childId === childId && kept.taskId === taskId && kept.deliveries.some(isOut)),
      draft: (taskId, question) => answers[answerKey(childId, taskId, question)]?.draft ?? EMPTY_ANSWER_DRAFT,
      edit: (taskId, question, draft) => change((current) => {
        const key = answerKey(childId, taskId, question);
        const kept = current[key] ?? { childId, taskId, question, title, draft: EMPTY_ANSWER_DRAFT, deliveries: [] };
        // Clearing a refused field is letting it go; any other edit leaves what was sent as it was.
        const cleared = (field: Field) => typed(kept.draft, field) !== '' && typed(draft, field) === '';
        const deliveries = kept.deliveries.map((delivery) => (isOut(delivery)
          ? delivery
          : { ...delivery, sent: Object.fromEntries(Object.entries(delivery.sent).filter(([field]) => !cleared(field as Field))) }));
        return { ...current, [key]: { ...kept, title, draft, deliveries } };
      }),
      give: (taskId, { question, answer, words, raiseTokens }) => {
        const key = answerKey(childId, taskId, question);
        const root = childId === ROOT_ANSWERS;
        const answerId = `${page.current}-${nextAnswer.current++}`;
        change((current) => {
          const kept = current[key];
          const form = kept?.draft ?? EMPTY_ANSWER_DRAFT;
          const field: Field = answer === 'approve' ? 'words' : 'reason';
          const sent = {
            // A wordless approval sent no words, so none are its to show.
            ...(words?.trim() ? { [field]: words.trim() } : {}),
            // As typed, so the form is not taken for something else: "7e5" is a raise too.
            ...(raiseTokens !== undefined ? { raise: typed(form, 'raise') || String(raiseTokens) } : {}),
          };
          const delivery: Delivery = { id: answerId, sent, given: form };
          // The root's card closes, so a question asked again finds its form blank.
          return { ...current, [key]: { childId, taskId, question, title, draft: root ? EMPTY_ANSWER_DRAFT : form, deliveries: [...(kept?.deliveries ?? []), delivery] } };
        });
        post(root
          ? { type: 'answerCheckpoint', answerId, taskId, approved: answer === 'approve', ...(words ? { reason: words } : {}), ...(raiseTokens !== undefined ? { raiseTokens } : {}) }
          : { type: 'answerChildCheckpoint', answerId, childId, taskId, question, answer, ...(words ? { reason: words } : {}) });
        return answerId;
      },
      undelivered: (offered) => Object.values(answers)
        .filter((kept) => kept.childId === childId && !offered(kept.taskId, kept.question))
        .map(listed)
        .filter((item): item is Undelivered => item !== undefined),
      dismiss: (taskId, question, part) => discard(childId, taskId, question, part),
    }),
  };
}
