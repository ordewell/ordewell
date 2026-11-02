import React, { useEffect, useRef, useState } from 'react';
import type { ChildPlanEntry, ChildPlanView, RunTask, SurfaceTask } from '@ordewell/core';
import { patchedBlocks, type PatchedView } from '../../../shared/conversationPatch';
import type { WebviewToHost } from '../../../shared/protocol';
import type { ChildAnswers, ChildComposer, GivenAnswer } from '../childDrafts';
import { ConversationBlocks } from './ChatMessage';
import CheckpointPanel from './CheckpointPanel';

function findRun(tasks: readonly RunTask[], id: string): RunTask | undefined {
  for (const task of tasks) {
    if (task.id === id) return task;
    const found = findRun(task.subtasks, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Where the tree is waiting on a person. A child's questions stay out of the
 * root inbox (ADR-0055 D20), and a depth-2 one has no row in the root's plan at
 * all, so this is how it is found without opening each child in turn.
 */
export function ChildQuestions({ tree, current, onOpen }: { tree: readonly ChildPlanEntry[]; current?: string; onOpen: (childId: string) => void }) {
  const waiting = tree.filter((entry) => entry.sessionId !== current && entry.checkpoints?.length);
  if (waiting.length === 0) return null;
  return <div className="child-questions" role="region" aria-label="Questions in subplanners">
    {waiting.map((entry) => <button type="button" key={entry.sessionId} onClick={() => onOpen(entry.sessionId)}>A question waits in {entry.title}</button>)}
  </div>;
}

/** Whose news it is: a panel shows only its own, and an empty id is nobody's in particular. */
export interface ChildNotice { childId: string; message: string }

export const NO_CHILD_NOTICE: ChildNotice = { childId: '', message: '' };

interface AnswerableProps {
  title: string;
  question: string;
  delegated: boolean;
  answering: boolean;
  given?: GivenAnswer;
  onAnswer: (answer: 'approve' | 'reject', words?: string) => void;
}

/**
 * Disabled rather than replaced while the answer is out: a refusal has to find
 * the person's words where they left them. A raise is the parent's to give
 * (ADR-0056 M8), so the panel offers none here.
 */
function AnswerableQuestion({ title, question, delegated, answering, given, onAnswer }: AnswerableProps) {
  const [pausedAt] = useState(() => Date.now());
  return <fieldset className="child-question" disabled={answering} aria-label={`Question on ${title}`}>
    <CheckpointPanel taskTitle={title} summary={question} pausedAt={pausedAt} delegated={delegated} raisable={false} given={given}
      onApprove={(words) => onAnswer('approve', words)} onReject={(reason) => onAnswer('reject', reason)} />
  </fieldset>;
}

interface ChildPlanPanelProps {
  view: ChildPlanView;
  tree: readonly ChildPlanEntry[];
  conversation: PatchedView;
  notice: ChildNotice;
  composer: ChildComposer;
  answers: ChildAnswers;
  /** The root plan's own waiting question, kept in reach while a child is read. */
  rootQuestion?: string;
  post: (message: WebviewToHost) => void;
  onOpen: (childId: string) => void;
  onBack: () => void;
  onRootQuestion: () => void;
}

/** One child plan. App keys it by session, so another child starts clean, and holds what is written or answered to it. */
export default function ChildPlanPanel({ view, tree, conversation, notice, composer, answers, rootQuestion, post, onOpen, onBack, onRootQuestion }: ChildPlanPanelProps) {
  const { child } = view;
  const childId = child.sessionId;
  const [unstarted, setUnstarted] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const tasks = useRef<HTMLHeadingElement>(null);
  // Not child.refused: that is a message's refusal, and an answer opens no turn.
  const answerable = child.state !== 'ended';

  useEffect(() => { heading.current?.focus(); }, []);

  const drawTask = (task: SurfaceTask): React.ReactNode => {
    const live = findRun(view.run.tasks, task.id);
    const question = live?.awaitingReason === 'checkpoint' ? live.checkpoint : undefined;
    // A retried task keeps its ended child alongside the fresh one: both read.
    const descendants = tree.filter((entry) => entry.parent === childId && entry.taskId === task.id);
    return <div className="child-task" key={task.id}>
      <span>{task.title} · {live?.status ?? task.status}</span>
      {question && (answerable
        ? <AnswerableQuestion key={question} title={task.title} question={question} delegated={task.type === 'delegated'} answering={answers.out(task.id)} given={answers.given(task.id, question)} onAnswer={(answer, words) => answers.give(task.id, { question, answer, words })} />
        : <p>{question}</p>)}
      {(task.attempted || live?.attempted) && <button type="button" onClick={() => post({ type: 'openChildTaskLog', childId, taskId: task.id })}>Open chat</button>}
      {task.type === 'delegated' && descendants.map((entry) =>
        <button type="button" key={entry.sessionId} onClick={() => onOpen(entry.sessionId)}>Open subplanner: {entry.title} · {entry.state}</button>)}
      {task.type === 'delegated' && descendants.length === 0 && <button type="button" onClick={() => setUnstarted(task.id)}>Open subplanner</button>}
      {task.type === 'delegated' && descendants.length === 0 && unstarted === task.id && <p>No child plan has started.</p>}
      {task.subtasks.length > 0 && <div>{task.subtasks.map(drawTask)}</div>}
    </div>;
  };

  return <div className="chat-container child-plan-view">
    <nav aria-label="Subplanner navigation">
      <button type="button" onClick={onBack}>Back to parent</button>
      {rootQuestion && <button type="button" onClick={onRootQuestion}>A question awaits: {rootQuestion}</button>}
    </nav>
    <h2 ref={heading} tabIndex={-1}>{child.title}</h2>
    {view.goal && <p>{view.goal}</p>}
    <ChildQuestions tree={tree} current={childId} onOpen={onOpen} />
    <ConversationBlocks blocks={patchedBlocks(conversation)} onShowPlan={() => tasks.current?.focus()} />
    <h3 ref={tasks} tabIndex={-1}>Tasks</h3>
    {view.plan?.tasks.map(drawTask)}
    {child.state === 'ended' ? <p>View only</p> : child.refused ? <p>{child.refused}</p> : <form onSubmit={(event) => {
      event.preventDefault();
      composer.send();
    }}><label>Message subplanner<textarea value={composer.text} onChange={(event) => composer.write(event.target.value)} /></label><button type="submit" disabled={composer.sending}>Send</button></form>}
    {(!notice.childId || notice.childId === childId) && notice.message && <p role="status">{notice.message}</p>}
  </div>;
}
