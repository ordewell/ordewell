import { act, fireEvent } from '@testing-library/react';
import type { HostToWebview } from '../../shared/protocol';
import { hostApi } from '../../test/hostApi';

export function post(msg: HostToWebview): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

export const api = hostApi;

/** The top-level rows of the conversation, by the class that names their kind. */
export function rowKinds(): string[] {
  return [...document.querySelectorAll('.conversation > *')].map((el) => el.className.split(' ')[0]);
}

/** Opens every run of activity still folded, as a reader would to see its rows. */
export function openActivity(): void {
  document.querySelectorAll<HTMLButtonElement>('.activity-group-toggle[aria-expanded="false"]').forEach((b) => fireEvent.click(b));
}

/** The rows inside the open runs of activity, in order, by the class that names their kind. */
export function activityRows(): string[] {
  return [...document.querySelectorAll('.activity-group-body > *')].map((el) => el.className.split(' ')[0]);
}

/** The identity of the latest checkpoint answer the webview sent, which the host's result names back. */
export function lastAnswerId(): string {
  const sent = api.post.mock.calls.map(([message]) => message as { type: string; answerId?: string });
  const answer = sent.reverse().find((message) => message.type === 'answerCheckpoint' || message.type === 'answerChildCheckpoint');
  if (!answer?.answerId) throw new Error('No checkpoint answer was sent.');
  return answer.answerId;
}
