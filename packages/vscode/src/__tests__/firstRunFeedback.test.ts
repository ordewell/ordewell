import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { createEmptyPlan, type ExecutionSummary, type LegacyPlanState } from '@ordewell/core';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { handleSessionMessage, type PlanManagerDeps } from '../plan/PlanManager';
import { showFirstRunFeedback } from '../firstRunFeedback';

vi.mock('vscode', () => ({
  EventEmitter: class {
    listeners: ((e: unknown) => void)[] = [];
    event = (fn: (e: unknown) => void) => { this.listeners.push(fn); return { dispose() {} }; };
    fire(e: unknown) { for (const fn of this.listeners) fn(e); }
  },
  Uri: { joinPath: (...parts: unknown[]) => ({ toString: () => parts.join('/') }) },
  commands: { executeCommand: vi.fn() },
}));

const MESSAGE = 'How did it go? Ordewell is open source and built in the open, and feedback from a first run is what it needs most.';
const PASSED: ExecutionSummary = { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 };

/** VS Code's notification API, answering with the button the person picks, or none for the close button. */
function fakeHost(choose?: string) {
  const showInformationMessage = vi.fn(async (..._args: unknown[]) => choose);
  const openExternal = vi.fn(async (_uri: { toString(): string }) => true);
  return {
    host: {
      window: { showInformationMessage },
      env: { openExternal },
      Uri: { parse: (value: string) => ({ toString: () => value }) },
    } as never,
    showInformationMessage,
    opened: () => openExternal.mock.calls.map(([uri]) => uri.toString()),
  };
}

describe('the first-run feedback notice in VS Code (ADR-0075)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-feedback-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const show = (fake: ReturnType<typeof fakeHost>, summary = PASSED, interactive = true): Promise<void> =>
    showFirstRunFeedback(fake.host, summary, { interactive, env: {}, stateDir });

  it('is an information message with its two actions; VS Code\'s own close is the dismiss', async () => {
    const fake = fakeHost();
    await show(fake);
    expect(fake.showInformationMessage).toHaveBeenCalledWith(MESSAGE, 'Tell us how it went', 'Star on GitHub');
    expect(fake.opened()).toEqual([]);
  });

  it.each<[string, string]>([
    ['Tell us how it went', 'https://github.com/ordewell/ordewell/discussions/115'],
    ['Star on GitHub', 'https://github.com/ordewell/ordewell'],
  ])('opens a browser only when %s is picked', async (label, url) => {
    const fake = fakeHost(label);
    await show(fake);
    expect(fake.opened()).toEqual([url]);
  });

  it('is shown once on the machine, in the record the TUI and the desktop app read', async () => {
    const fake = fakeHost();
    await show(fake);
    await show(fake);
    expect(fake.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(stateDir, 'first-run-feedback.json'))).toBe(true);
  });

  it('is not shown after a failed run, nor in an extension host under test', async () => {
    const fake = fakeHost();
    await show(fake, { total: 2, completed: 1, failed: 1, blocked: 0, skipped: 0 });
    await show(fake, PASSED, false);
    expect(fake.showInformationMessage).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  describe('from the session\'s own messages', () => {
    function host() {
      const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
      const plan: LegacyPlanState = { ...createEmptyPlan(), status: 'approved' };
      const firstRunFeedback = vi.fn();
      const deps = {
        session: { isExecuting: false, status: 'completed', planState: plan, activity: undefined },
        chatProvider: provider,
        getCurrentPlan: () => plan,
        setCurrentPlan: () => {},
        persistState: vi.fn(),
        isGeneratingPlan: () => false,
        firstRunFeedback,
      } as unknown as PlanManagerDeps;
      return { deps, firstRunFeedback };
    }

    it('asks once the run\'s end stands with every task passed, not at its first end', () => {
      const { deps, firstRunFeedback } = host();
      handleSessionMessage({ type: 'execution_complete', summary: PASSED }, deps);
      expect(firstRunFeedback).not.toHaveBeenCalled();
      handleSessionMessage({ type: 'run_concluded', summary: { total: 2, completed: 1, failed: 0, blocked: 0, skipped: 1 } }, deps);
      expect(firstRunFeedback).not.toHaveBeenCalled();
      handleSessionMessage({ type: 'run_concluded', summary: PASSED }, deps);
      expect(firstRunFeedback).toHaveBeenCalledWith(PASSED);
    });
  });
});
