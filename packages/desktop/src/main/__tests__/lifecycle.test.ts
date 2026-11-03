import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { onLastWindowClosed, quitPrompt } from '../lifecycle';
import { isInside } from '../paths';

const run = { sessionId: 's1', goal: 'Ship it', workspace: '/w' };

describe('onLastWindowClosed (ADR-0060 H5)', () => {
  it('keeps the app in the tray while a run is live, or when that cannot be told', () => {
    expect(onLastWindowClosed([run], 'linux')).toBe('tray');
    expect(onLastWindowClosed([run], 'darwin')).toBe('tray');
    expect(onLastWindowClosed(undefined, 'win32')).toBe('tray');
  });

  it('quits with nothing live, except on macOS where the app stays in the Dock', () => {
    expect(onLastWindowClosed([], 'linux')).toBe('quit');
    expect(onLastWindowClosed([], 'win32')).toBe('quit');
    expect(onLastWindowClosed([], 'darwin')).toBe('stay');
  });
});

describe('quitPrompt (ADR-0060 H5)', () => {
  it('does not ask when nothing is live', () => {
    expect(quitPrompt([], true)).toBeUndefined();
    expect(quitPrompt([], false)).toBeUndefined();
  });

  it('says an owned daemon\'s runs stop with the app', () => {
    const prompt = quitPrompt([run], true);
    expect(prompt?.message).toBe('A run is in progress. Quit and stop it?');
    expect(prompt?.detail).toContain('• Ship it (/w)');
    expect(prompt?.detail).toContain('quitting stops the daemon and the runs with it');
    expect(prompt?.confirmLabel).toBe('Stop and quit');
  });

  it('says an attached daemon\'s runs go on', () => {
    const prompt = quitPrompt([run, { ...run, sessionId: 's2' }], false);
    expect(prompt?.message).toBe('2 runs are in progress. Quit Ordewell?');
    expect(prompt?.detail).toContain('keeps running and the runs go on');
    expect(prompt?.confirmLabel).toBe('Quit');
  });

  it('still asks when the runs could not be checked', () => {
    const prompt = quitPrompt(undefined, true);
    expect(prompt?.message).toBe('A run may be in progress. Quit and stop them?');
    expect(prompt?.detail).toContain('could not check the daemon');
  });
});

describe('isInside', () => {
  const root = resolve('/bundle/renderer');

  it('accepts a file under the root', () => {
    expect(isInside(root, join(root, 'index.html'))).toBe(true);
    expect(isInside(root, join(root, 'assets', 'a.js'))).toBe(true);
  });

  it('refuses the root itself, a sibling and anything above', () => {
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, resolve('/bundle/renderer-evil/x.js'))).toBe(false);
    expect(isInside(root, resolve(root, '..', 'main', 'index.js'))).toBe(false);
    expect(isInside(root, resolve('/etc/passwd'))).toBe(false);
  });

  it('accepts a file whose name merely starts with two dots', () => {
    expect(isInside(root, join(root, '..hidden'))).toBe(true);
  });
});

describe('quitPrompt with terminals (ADR-0062 G11)', () => {
  it('does not ask for a terminal sitting at its prompt', () => {
    expect(quitPrompt([], true, 0)).toBeUndefined();
  });

  it('asks when a terminal is running a process, with no run live', () => {
    const one = quitPrompt([], false, 1);
    expect(one?.message).toBe('A terminal is running a process. Quit Ordewell?');
    expect(quitPrompt([], false, 3)?.message).toBe('3 terminals are running a process. Quit Ordewell?');
  });

  it('asks the run question and the terminal one together', () => {
    const prompt = quitPrompt([run], true, 2);
    expect(prompt?.message).toBe('A run is in progress. Quit and stop it?');
    expect(prompt?.detail).toContain('2 terminals are running a process');
    expect(prompt?.confirmLabel).toBe('Stop and quit');
  });
});
