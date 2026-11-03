import { vi } from 'vitest';
import type { PtyProcess, PtySpawn } from '../TerminalHost';

export interface FakePty extends PtyProcess {
  process: string;
  emit(data: string): void;
  exit(exitCode: number, signal?: number): void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

/** A pty that is a pair of callbacks: what the shell prints and when it ends. */
export function fakeSpawn(): { spawn: PtySpawn; ptys: FakePty[]; calls: Array<{ file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }> } {
  const ptys: FakePty[] = [];
  const calls: Array<{ file: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }> = [];
  const spawn: PtySpawn = (file, args, options) => {
    calls.push({ file, args, ...options });
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
    const pty: FakePty = {
      process: 'zsh',
      onData: (listener) => { onData = listener; return { dispose: () => undefined }; },
      onExit: (listener) => { onExit = listener; return { dispose: () => undefined }; },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emit: (data) => onData(data),
      exit: (exitCode, signal) => onExit({ exitCode, ...(signal ? { signal } : {}) }),
    };
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys, calls };
}
