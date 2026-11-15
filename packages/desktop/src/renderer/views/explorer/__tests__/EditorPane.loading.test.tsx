import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as monaco from '../../../monaco';
import type { EditorHandle } from '../../../monaco';
import { EditorPane } from '../EditorPane';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());
afterEach(() => vi.restoreAllMocks());

describe('loading the editor', () => {
  it('keeps a named skeleton while Monaco loads after the file is ready', async () => {
    const api = await monaco.loadMonaco();
    let finish: ((value: Awaited<ReturnType<typeof monaco.loadMonaco>>) => void) | undefined;
    vi.spyOn(monaco, 'loadMonaco').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const handle: { current: EditorHandle | undefined } = { current: undefined };
    render(<EditorPane modelKey="test" path="file.ts" text="export const ready = true;" readOnly={false} handle={handle} />);
    expect(screen.getByRole('status', { name: 'Loading editor…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading editor…')).toBeInTheDocument();
    await act(async () => finish?.(api));
    expect(screen.queryByRole('status')).toBeNull();
    expect(handle.current?.getText()).toBe('export const ready = true;');
  });

  it('replaces progress with the editor failure', async () => {
    vi.spyOn(monaco, 'loadMonaco').mockRejectedValue(new Error('The editor bundle could not load.'));
    render(<EditorPane modelKey="test" path="file.ts" text="" readOnly handle={{ current: undefined }} />);
    expect(await screen.findByText('The editor bundle could not load.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
