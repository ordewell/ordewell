import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { containersOffered, type DockerCli } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';

const fn = (mock: unknown) => mock as ReturnType<typeof vi.fn>;
const registerCommand = fn(vscode.commands.registerCommand);
const executeCommand = fn(vscode.commands.executeCommand);
const showQuickPick = fn(vscode.window.showQuickPick);
const showInputBox = fn(vscode.window.showInputBox);
const showInformationMessage = fn(vscode.window.showInformationMessage);
const showErrorMessage = fn(vscode.window.showErrorMessage);

const answer = (stdout: string, code = 0) => ({ code, stdout, stderr: '' });

/** A local Colima, or no docker at all: the only ways out of a machine this test can tell apart. */
const docker = (present: boolean): DockerCli => ({
  call: async (args) => {
    if (!present) return { code: -1, stdout: '', stderr: 'spawn docker ENOENT' };
    if (args[0] === 'context') return answer('unix:///tmp/docker.sock\n');
    if (args[0] === 'version') return answer('29.5.2\n');
    if (args[0] === 'info') return answer('linux|2|16733052928\n');
    return answer('', 1);
  },
  entry: async () => { throw new Error('nothing here runs a process in a container'); },
});

function registered(opts: { saved?: unknown; present?: boolean; setup?: string } = {}) {
  registerCommand.mockClear();
  executeCommand.mockClear();
  let saved = opts.saved;
  const settingsService = {
    getAll: () => ({ containers: saved }),
    updateContainers: (change: (held: unknown) => unknown) => { saved = change(saved); },
  };
  const config = { worktreeSetupCommand: opts.setup };
  const deps = { settingsService, config, dockerCli: docker(opts.present ?? true) } as unknown as CommandDeps;
  registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, deps);
  const command = registerCommand.mock.calls.find(([id]) => id === 'ordewell.containers')?.[1] as (() => Promise<void>) | undefined;
  return { command, saved: () => saved };
}

const pick = (value: string): void => {
  showQuickPick.mockImplementationOnce(async (items: Array<{ value: string }>) => items.find((item) => item.value === value));
};

const shown = (): string => JSON.stringify(showInformationMessage.mock.calls.at(-1));

describe('ordewell.containers, where this build offers them (ADR-0059 L5)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const offered = () => {
    vi.stubEnv('ORDEWELL_CONTAINERS', '1');
    expect(containersOffered()).toBe(true);
  };

  it('shows in the palette, by the context its menu entry is gated on', () => {
    offered();

    registered();

    expect(executeCommand).toHaveBeenCalledWith('setContext', 'ordewell.containersOffered', true);
  });

  it('turns on over a Docker that answers, with the image and login still to choose', async () => {
    offered();
    const { command, saved } = registered();
    pick('on');

    await command!();

    expect(saved()).toEqual({});
    expect(shown()).toContain('No image has been chosen');
    expect(shown()).toContain('Assumed or left uncovered');
  });

  it('stays off where there is no Docker, and says how to get one', async () => {
    offered();
    const { command, saved } = registered({ present: false });
    pick('on');

    await command!();

    expect(saved()).toBeUndefined();
    expect(JSON.stringify(showErrorMessage.mock.calls)).toContain('The docker command was not found');
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('names an image, over what the file holds', async () => {
    offered();
    const { command, saved } = registered({ saved: { memory: '2g' } });
    pick('image');
    showInputBox.mockResolvedValueOnce('ordewell-task');

    await command!();

    expect(saved()).toEqual({ memory: '2g', image: 'ordewell-task' });
  });

  it('takes the variables a broker hands over, by name', async () => {
    offered();
    const { command, saved } = registered({ saved: {} });
    pick('broker');
    showInputBox.mockResolvedValueOnce('ANTHROPIC_API_KEY, AWS_REGION');

    await command!();

    expect(saved()).toEqual({ login: { kind: 'broker', variables: ['ANTHROPIC_API_KEY', 'AWS_REGION'] } });
  });

  it('changes nothing when the input box is dismissed', async () => {
    offered();
    const { command, saved } = registered({ saved: { image: 'kept' } });
    pick('image');
    showInputBox.mockResolvedValueOnce(undefined);

    await command!();

    expect(saved()).toEqual({ image: 'kept' });
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('counts the window\'s worktree setup command against a task, as a lease would', async () => {
    offered();
    const { command } = registered({ saved: {}, setup: 'npm ci' });
    pick('status');

    await command!();

    expect(shown()).toContain('A worktree setup command is set');
  });

  it('starts nothing to report where it stands', async () => {
    offered();
    const { command } = registered({ saved: {} });
    pick('status');

    await command!();

    expect(shown()).toContain('Nothing has been proven yet');
  });
});

describe('ordewell.containers, as a published build has it', () => {
  it('is neither registered nor put in the palette', () => {
    expect(containersOffered()).toBe(false);

    const { command } = registered();

    expect(command).toBeUndefined();
    expect(executeCommand).not.toHaveBeenCalledWith('setContext', 'ordewell.containersOffered', true);
  });
});
