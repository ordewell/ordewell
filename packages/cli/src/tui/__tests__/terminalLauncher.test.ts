import { describe, it, expect, vi } from 'vitest';
import { openTaskTerminal, type TerminalLauncherDeps } from '../terminalLauncher';

const SESSION = 'session-1753000042111';
// tmuxWindowName(taskId, SESSION): scope is the session slug's last 6 chars.
const WINDOW = 't-042111-task1234abcd';

function deps(overrides: Partial<TerminalLauncherDeps> = {}): TerminalLauncherDeps {
  return {
    platform: 'linux',
    env: { DISPLAY: ':0' },
    hasTmuxImpl: () => true,
    execFileImpl: vi.fn().mockResolvedValue({ stdout: `${WINDOW}\n`, stderr: '' }),
    spawnImpl: vi.fn(),
    which: () => true,
    ...overrides,
  };
}

const open = (d: TerminalLauncherDeps) => openTaskTerminal(3742, SESSION, 'task-1234-abcd', d);

describe('openTaskTerminal', () => {
  it('reports tmux is missing without touching anything else', async () => {
    const d = deps({ hasTmuxImpl: () => false, execFileImpl: vi.fn(), spawnImpl: vi.fn() });
    const result = await open(d);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/tmux/i);
    expect(d.execFileImpl).not.toHaveBeenCalled();
    expect(d.spawnImpl).not.toHaveBeenCalled();
  });

  it("reports a friendly message when the task's window doesn't exist yet", async () => {
    const d = deps({ execFileImpl: vi.fn().mockResolvedValue({ stdout: 't-other\n', stderr: '' }) });
    const result = await open(d);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/hasn't/i);
    expect(d.spawnImpl).not.toHaveBeenCalled();
  });

  it('reports a friendly message when the daemon has no tmux session at all', async () => {
    const d = deps({ execFileImpl: vi.fn().mockRejectedValue(new Error("can't find session")) });
    const result = await open(d);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no terminal session/i);
  });

  it("only matches this plan's window, not another plan's identically named task", async () => {
    const d = deps({ execFileImpl: vi.fn().mockResolvedValue({ stdout: 't-999999-task1234abcd\n', stderr: '' }) });
    const result = await open(d);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/hasn't/i);
  });

  it('attaches to the latest attempt after retries opened fresh windows', async () => {
    const d = deps({
      which: (bin) => bin === 'gnome-terminal',
      execFileImpl: vi.fn().mockResolvedValue({
        stdout: `${WINDOW}\n${WINDOW}-3\n${WINDOW}-2\nt-other\n`,
        stderr: '',
      }),
    });
    const result = await open(d);

    expect(result.ok).toBe(true);
    expect(d.spawnImpl).toHaveBeenCalledWith(
      'gnome-terminal',
      expect.arrayContaining([expect.stringContaining(`:${WINDOW}-3`)]),
    );
  });

  it('attaches through a grouped viewer session so concurrent terminals stay independent', async () => {
    const d = deps({
      which: () => true,
      execFileImpl: vi.fn().mockResolvedValue({ stdout: `${WINDOW}\n`, stderr: '' }),
    });
    const result = await open(d);

    expect(result.ok).toBe(true);
    const arg = (d.spawnImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].join(' ');
    expect(arg).toMatch(/new-session -d -s ordewell-3742-view-\S+ -t ordewell-3742/);
    expect(arg).toContain('destroy-unattached on');
    expect(arg).toContain(`:${WINDOW}`);
    expect(arg).toMatch(/attach-session -t ordewell-3742-view-\S+/);
  });

  it('opens Terminal.app on macOS with the attach command', async () => {
    const d = deps({ platform: 'darwin' });
    const result = await open(d);

    expect(result.ok).toBe(true);
    expect(d.spawnImpl).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining(`:${WINDOW}`)]),
    );
  });

  it('tries gnome-terminal on linux with a display and a terminal available', async () => {
    const which = vi.fn((bin: string) => bin === 'gnome-terminal');
    const d = deps({ which });
    const result = await open(d);

    expect(result.ok).toBe(true);
    expect(d.spawnImpl).toHaveBeenCalledWith(
      'gnome-terminal',
      expect.arrayContaining([expect.stringContaining(`:${WINDOW}`)]),
    );
  });

  it('falls back to a manual-attach message on a headless linux box (no DISPLAY)', async () => {
    const d = deps({ env: {} });
    const result = await open(d);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`tmux -L ordewell-3742 attach -t ordewell-3742:${WINDOW}`);
    expect(d.spawnImpl).not.toHaveBeenCalled();
  });

  it('falls back to a manual-attach message when no terminal emulator is found', async () => {
    const d = deps({ which: () => false });
    const result = await open(d);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`tmux -L ordewell-3742 attach -t ordewell-3742:${WINDOW}`);
  });

  it('tries Windows Terminal on win32 when available', async () => {
    const d = deps({ platform: 'win32' });
    const result = await open(d);

    expect(result.ok).toBe(true);
    expect(d.spawnImpl).toHaveBeenCalledWith('wt.exe', expect.any(Array));
  });
});
