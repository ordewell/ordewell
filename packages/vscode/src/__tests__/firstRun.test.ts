import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { markWalkthroughStep, revealOnFirstActivation } from '../firstRun';

const ROOT = path.join(__dirname, '../..');

interface Manifest {
  capabilities?: { untrustedWorkspaces?: { supported?: unknown; description?: string } };
  contributes: {
    commands: Array<{ command: string }>;
    views: Record<string, Array<{ id: string }>>;
    walkthroughs?: Array<{
      id: string;
      title: string;
      steps: Array<{ id: string; title: string; description: string; media: { markdown?: string }; completionEvents?: string[] }>;
    }>;
  };
}

const manifest = (): Manifest => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
  };
}

describe('the first activation after install (F5)', () => {
  beforeEach(() => vi.mocked(vscode.commands.executeCommand).mockClear());

  it('reveals the Ordewell view once, and not on the next activation', async () => {
    const store = memento();
    await revealOnFirstActivation(vscode.commands, store);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('ordewellChatView.focus');

    vi.mocked(vscode.commands.executeCommand).mockClear();
    await revealOnFirstActivation(vscode.commands, store);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('remembers the reveal in the store every window shares', async () => {
    const store = memento();
    await revealOnFirstActivation(vscode.commands, store);
    expect(store.update).toHaveBeenCalledTimes(1);
    // A second window reads the same globalState and stays where the user left it.
    vi.mocked(vscode.commands.executeCommand).mockClear();
    await revealOnFirstActivation(vscode.commands, memento({ [store.update.mock.calls[0][0]]: store.update.mock.calls[0][1] }));
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('still counts as revealed when focusing the view fails, so it is not retried on every start', async () => {
    const store = memento();
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error('no such view'));
    await revealOnFirstActivation(vscode.commands, store);
    expect(store.update).toHaveBeenCalledTimes(1);
  });
});

describe('the walkthrough (F5)', () => {
  const walkthrough = () => {
    const all = manifest().contributes.walkthroughs ?? [];
    expect(all).toHaveLength(1);
    return all[0];
  };

  it('has three steps in order: open the view, give a goal, run the plan', () => {
    expect(walkthrough().steps.map((step) => step.title)).toEqual([
      'Open the Ordewell view',
      'Give it a goal',
      'Run the plan',
    ]);
  });

  it('gives each step a markdown page that ships in the extension', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!media/**');
    for (const step of walkthrough().steps) {
      expect(step.media.markdown, step.id).toMatch(/^media\//);
      expect(fs.existsSync(path.join(ROOT, step.media.markdown ?? '')), step.media.markdown).toBe(true);
    }
  });

  it('links only commands the extension contributes, and completes each step on what the user did', () => {
    const contributed = new Set(manifest().contributes.commands.map((entry) => entry.command));
    const views = new Set(Object.values(manifest().contributes.views).flat().map((view) => view.id));
    for (const step of walkthrough().steps) {
      for (const [, command] of step.description.matchAll(/\(command:([\w.]+)/g)) expect(contributed, command).toContain(command);
      expect(step.completionEvents?.length, step.id).toBeGreaterThan(0);
    }
    const [open, goal, approve] = walkthrough().steps;
    expect(open.completionEvents).toContain('onView:ordewellChatView');
    expect(views).toContain('ordewellChatView');
    expect(goal.completionEvents).toEqual(['onContext:ordewell.walkthrough.goalGiven']);
    expect(approve.completionEvents).toEqual(['onContext:ordewell.walkthrough.planApproved']);
  });

  it('sets the context key a step completes on', () => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
    markWalkthroughStep('goalGiven');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'ordewell.walkthrough.goalGiven', true);
    markWalkthroughStep('planApproved');
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'ordewell.walkthrough.planApproved', true);
  });
});

describe('workspace trust', () => {
  // Ordewell runs coding agents in the folder and reads its .envrc and
  // .ordewell/env and its worktreeSetup command: nothing of it is safe in a
  // folder the user has not trusted, so Restricted Mode turns it off, and
  // says why rather than leaving the panel missing unexplained.
  it('declares that it does not run in Restricted Mode, and says why', () => {
    const trust = manifest().capabilities?.untrustedWorkspaces;
    expect(trust?.supported).toBe(false);
    expect(trust?.description).toMatch(/trust/i);
  });
});
