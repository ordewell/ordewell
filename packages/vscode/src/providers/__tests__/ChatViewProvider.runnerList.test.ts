import { describe, it, expect } from 'vitest';
import type * as vscode from 'vscode';
import { ChatViewProvider } from '../ChatViewProvider';
import type { HostToWebview } from '@ordewell/ui/protocol';

function provider() {
  const posted: HostToWebview[] = [];
  const chat = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  chat.postMessage = (message) => { posted.push(message); };
  const runnerLists = () => posted.flatMap((m) => (m.type === 'setRunners' ? [m.runners] : []));
  return { chat, runnerLists };
}

/**
 * The webview says it is detecting coding agents until it hears the installed
 * runners, so the answer "none" has to reach it as surely as a list does.
 */
describe('ChatViewProvider tells the webview which runners are installed', () => {
  it('sends an empty list once discovery found no agent', () => {
    const { chat, runnerLists } = provider();

    chat.setRunnerList([]);

    expect(runnerLists()).toEqual([[]]);
  });

  it('sends it again to a reloaded webview', () => {
    const { chat, runnerLists } = provider();
    chat.setRunnerList([]);

    chat.resendAllState();

    expect(runnerLists()).toEqual([[], []]);
  });

  it('sends nothing before discovery has listed the runners', () => {
    const { chat, runnerLists } = provider();

    chat.setEnabledRunnerIds(['claude-code']);
    chat.resendAllState();

    expect(runnerLists()).toEqual([]);
  });
});
