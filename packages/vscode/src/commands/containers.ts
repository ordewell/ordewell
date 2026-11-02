import * as vscode from 'vscode';
import { changeContainers, containerStatus, containersOffered, describeContainers, describeProblems, type ContainerChange, type ContainerStatus, type DockerCli, type SettingsService } from '@ordewell/core';

export interface ContainersDeps {
  settingsService: Pick<SettingsService, 'getAll' | 'updateContainers'>;
  config: { worktreeSetupCommand?: string };
  dockerCli?: DockerCli;
}

type Choice = 'status' | 'check' | 'on' | 'off' | 'image' | 'own-sign-in' | 'broker';

const CHOICES: Array<vscode.QuickPickItem & { value: Choice }> = [
  { label: 'Where it stands', description: 'Starts nothing', value: 'status' },
  { label: 'Check now', description: 'Starts a throwaway container and reports what it proved', value: 'check' },
  { label: 'Turn on', description: 'Needs Docker running on this machine', value: 'on' },
  { label: 'Turn off', description: 'Forgets the image and login chosen', value: 'off' },
  { label: 'Choose the image', value: 'image' },
  { label: 'Use your own sign-in', description: 'Made in a container, as docs/containers.md shows', value: 'own-sign-in' },
  { label: 'Hand over variables', description: 'From the environment VS Code started from', value: 'broker' },
];

/** The change a choice makes, null for one that makes none, and undefined for a dismissed box. */
async function changeOf(choice: Choice): Promise<ContainerChange | null | undefined> {
  if (choice === 'on' || choice === 'off') return { on: choice === 'on' };
  if (choice === 'own-sign-in') return { login: { kind: choice } };
  if (choice === 'image') {
    const image = await vscode.window.showInputBox({ prompt: 'The image tasks run in', placeHolder: 'ordewell-task' });
    return image?.trim() ? { image: image.trim() } : undefined;
  }
  if (choice === 'broker') {
    const names = await vscode.window.showInputBox({ prompt: 'Names of the variables to hand over, not their values', placeHolder: 'ANTHROPIC_API_KEY' });
    const variables = names?.split(/[\s,]+/).filter(Boolean) ?? [];
    return variables.length > 0 ? { login: { kind: choice, variables } } : undefined;
  }
  return null;
}

/**
 * Running tasks in containers (ADR-0059 L5), asked of this machine's Docker as
 * this window's own leases are. The setting is the file every surface shares, and
 * only a checkout that asks for containers gets this command.
 */
export function registerContainers(context: vscode.ExtensionContext, { settingsService, config, dockerCli }: ContainersDeps): void {
  if (!containersOffered()) return;
  const cli = dockerCli ? { cli: dockerCli } : {};
  const status = (prove: boolean): Promise<ContainerStatus> => containerStatus(settingsService.getAll().containers, { ...cli, prove, setupCommand: config.worktreeSetupCommand });
  void vscode.commands.executeCommand('setContext', 'ordewell.containersOffered', true);
  context.subscriptions.push(
    vscode.commands.registerCommand('ordewell.containers', async () => {
      const picked = await vscode.window.showQuickPick(CHOICES, { placeHolder: 'Run tasks in containers (experimental)' });
      if (!picked) return;
      const change = await changeOf(picked.value);
      if (change === undefined) return;
      if (change) {
        const refused = await changeContainers(change, { settings: settingsService, ...cli });
        if (refused.length > 0) {
          void vscode.window.showErrorMessage('Containers were not changed', { modal: true, detail: describeProblems(refused) });
          return;
        }
      }
      const prove = picked.value === 'check';
      const report = prove
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting a throwaway container to measure it' }, () => status(true))
        : await status(false);
      void vscode.window.showInformationMessage('Containers', { modal: true, detail: describeContainers(report).join('\n') });
    }),
  );
}
