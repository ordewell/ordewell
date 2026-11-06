import React, { useState, useContext, useEffect } from 'react';
import type { RunnerCommand } from '@ordewell/core';
import type { HostToWebview } from '../../shared/protocol';
import { ChatBridgeContext } from '../../bridge';

/**
 * A card drawn outside the chat (the task log's, a test's) has no chat to ask,
 * so it offers no runner commands rather than failing.
 */
export function useTaskCommands(taskId: string) {
  const bridge = useContext(ChatBridgeContext);
  const [commands, setCommands] = useState<readonly RunnerCommand[]>([]);
  useEffect(() => {
    setCommands([]);
    if (!bridge) return;
    const unsubscribe = bridge.subscribe((msg: HostToWebview) => {
      if (msg.type === 'taskCommands' && msg.taskId === taskId) setCommands(msg.commands);
      if (msg.type === 'restoreChat') setCommands([]);
    });
    bridge.post({ type: 'getTaskCommands', taskId });
    return unsubscribe;
  }, [taskId, bridge]);
  return { commands, invoke: (name: string, args: string) => bridge?.post({ type: 'invokeTaskCommand', taskId, name, args }) };
}

export function taskCommand(text: string, commands: readonly RunnerCommand[]): { name: string; args: string } | null {
  if (!text.startsWith('/') || commands.length === 0) return null;
  const names = commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]).sort((a, b) => b.length - a.length);
  const name = names.find((candidate) => text === `/${candidate}` || text.startsWith(`/${candidate} `));
  if (!name) throw new Error('The runner does not offer that command. Type / to see its commands.');
  return { name, args: text.slice(name.length + 1).trim() };
}

export function useRunnerCommands(text: string, setText: (text: string) => void, commands: readonly RunnerCommand[]) {
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const matches = !dismissed && /^\/\S*$/.test(text)
    ? commands.filter((command) => [command.name, ...(command.aliases ?? [])].some((name) => name.startsWith(text.slice(1)))) : [];
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  const choose = (command: RunnerCommand) => { setText(`/${command.name} `); setSelected(0); };
  const change = (value: string) => { setText(value); setSelected(0); setDismissed(false); };
  const keyDown = (event: React.KeyboardEvent): boolean => {
    if (!matches.length || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') setDismissed(true);
    else if (event.key === 'ArrowDown') setSelected((index + 1) % matches.length);
    else if (event.key === 'ArrowUp') setSelected((index + matches.length - 1) % matches.length);
    else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey)) choose(matches[index]);
    else return false;
    event.preventDefault();
    return true;
  };
  const palette = matches.length > 0 && (
    <div className="runner-commands" role="listbox" aria-label="Runner commands">
      {matches.map((command, i) => (
        <button type="button" role="option" aria-selected={i === index} key={command.name}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(command)}>
          <strong>/{command.name}</strong> {command.argumentHint && <code>{command.argumentHint}</code>}
          <span>{command.description}</span>
        </button>
      ))}
    </div>
  );
  return { palette, keyDown, change };
}
