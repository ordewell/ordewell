import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonCallResult } from '../../../../shared/bridge';
import { fakeDaemon, ok } from '../../../session/__tests__/fakeDaemon';
import { IDLE_LIST_MS, useSessionList } from '../useSessionList';

afterEach(() => { vi.useRealTimers(); delete (document as { visibilityState?: unknown }).visibilityState; });

/** Each read held until the test answers it, by the workspace it asked for. */
function heldReads() {
  const out: Array<{ workspace: unknown; answer: (result: DaemonCallResult) => void }> = [];
  const daemon = fakeDaemon({
    'sessions.list': (params) => new Promise<DaemonCallResult>((resolve) => { out.push({ workspace: params?.workspace, answer: resolve }); }),
  });
  return { daemon, out };
}

const row = (id: string, goal: string) => ({ id, goal, status: 'approved', taskCount: 1, updatedAt: '2026-11-03T09:00:00.000Z' });

describe('useSessionList', () => {
  it("never shows one workspace's late answer as another's list", async () => {
    const { out } = heldReads();
    const { result, rerender } = renderHook(({ ws }) => useSessionList(ws, true, undefined, ''), { initialProps: { ws: '/work/acme' } });
    await vi.waitFor(() => expect(out).toHaveLength(1));

    rerender({ ws: '/work/other' });
    await vi.waitFor(() => expect(out).toHaveLength(2));
    expect(out.map((read) => read.workspace)).toEqual(['/work/acme', '/work/other']);
    await act(async () => { out[1]!.answer(ok([row('s9', 'Same id elsewhere')])); });
    expect(result.current).toEqual([expect.objectContaining({ id: 's9' })]);
    // acme's answer comes back last: it is no answer for the list now shown.
    await act(async () => { out[0]!.answer(ok([row('s1', 'Ship the parser')])); });
    expect(result.current).toEqual([expect.objectContaining({ id: 's9' })]);
  });

  it('sets no timer for an answer that lands while the window is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const { out } = heldReads();
    renderHook(() => useSessionList('/work/acme', true, undefined, ''));
    await vi.waitFor(() => expect(out).toHaveLength(1));

    visibility = 'hidden';
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { out[0]!.answer(ok([row('s1', 'Ship the parser')])); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * IDLE_LIST_MS); });
    expect(out).toHaveLength(1);
  });
});
