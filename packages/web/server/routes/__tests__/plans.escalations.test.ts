import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorBody, EscalationsResponse, ExecuteCommandResponse } from '@ordewell/core';
import { daemonHarness, task } from './daemonHarness';

/**
 * What waits on a person over HTTP (ADR-0053): the list a client reads, and
 * the one answer, as the user, in the shapes `execute-command` answers.
 */

type Harness = ReturnType<typeof daemonHarness>;

let harness: Harness;
afterEach(() => harness?.session.destroy());

/** A run whose t1 asks its runner's permission. */
async function asking(): Promise<Harness> {
  harness = daemonHarness();
  harness.load([task('t1', 1)]);
  await harness.command({ command: 'run_plan' });
  harness.latest('t1').requestPermission('perm-1', 'Write', { file_path: '/repo/a.txt' }, []);
  return harness;
}

const read = async (h: Harness) => (await (await h.app.request('/api/plans/s1/escalations')).json()) as EscalationsResponse;

describe('GET /escalations', () => {
  it('answers the list as the Session derives it', async () => {
    const h = await asking();

    expect(await read(h)).toEqual({ escalations: h.session.escalations() });
    expect((await read(h)).escalations.map((e) => e.id)).toEqual(['approval:t1:1:perm-1']);
  });
});

describe('POST /escalations/answer', () => {
  it('answers as the user, with the seam\'s line', async () => {
    const h = await asking();

    const res = await h.post('escalations/answer', { id: 'approval:t1:1:perm-1', option: 'allow' });

    expect(res.status).toBe(200);
    expect(await res.json() as ExecuteCommandResponse).toMatchObject({ ok: true, message: expect.stringContaining('Allowed') });
    expect((await read(h)).escalations).toEqual([]);
    expect(h.timeline().at(-1)?.record).toMatchObject({ command: 'answer_approval', actor: 'user', outcome: 'done' });
  });

  it('refuses a stale id in the one refusal shape', async () => {
    const h = await asking();
    await h.post('escalations/answer', { id: 'approval:t1:1:perm-1', option: 'allow' });

    const res = await h.post('escalations/answer', { id: 'approval:t1:1:perm-1', option: 'allow' });

    expect(res.status).toBe(400);
    expect(await res.json() as ErrorBody).toEqual({ error: 'That is no longer waiting on you: it was answered, or the run moved on. Nothing was changed.', code: 'refused' });
  });

  it('refuses a body with no id or option before the seam sees it', async () => {
    const h = await asking();
    const answer = vi.spyOn(h.session, 'answerEscalation');

    expect((await h.post('escalations/answer', { option: 'allow' })).status).toBe(400);

    expect(answer).not.toHaveBeenCalled();
  });

  it('passes the note and the user\'s yes through, and nothing that is not one', async () => {
    const h = await asking();
    const answer = vi.spyOn(h.session, 'answerEscalation');

    await h.post('escalations/answer', { id: 'approval:t1:1:perm-1', option: 'deny', note: 'not there', confirmed: 'yes' });

    expect(answer).toHaveBeenCalledWith('approval:t1:1:perm-1', 'deny', 'not there', false);
  });
});
