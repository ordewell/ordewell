import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { confirm } from '../ConfirmDialog';

afterEach(() => { document.body.innerHTML = ''; });

async function ask(destructive: boolean | undefined, cancelLabel?: string): Promise<{ answer: Promise<string | null> }> {
  let pending!: Promise<string | null>;
  await act(async () => {
    pending = confirm({
      kind: 'git_branch',
      message: 'Delete the branch feature/login?',
      choices: [{ id: 'delete', label: 'Delete' }],
      ...(destructive !== undefined ? { destructive } : {}),
      ...(cancelLabel ? { cancelLabel } : {}),
    });
  });
  return { answer: pending };
}

describe('the confirmation dialog', () => {
  it('starts focus on Cancel and draws a destructive yes in the failure style', async () => {
    const { answer } = await ask(true);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('session-confirm-destructive');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(await answer).toBeNull();
  });

  it('draws a plain yes as the primary action', async () => {
    const { answer } = await ask(false);
    expect(screen.getByRole('button', { name: 'Delete' })).not.toHaveClass('session-confirm-destructive');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    expect(await answer).toBe('delete');
  });

  it('calls the dismissing button what the caller says', async () => {
    const { answer } = await ask(undefined, 'Close');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await act(async () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); });
    expect(await answer).toBeNull();
  });
});
