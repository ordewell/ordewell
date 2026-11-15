import type { AgentEvent } from '../../AgentAdapter';
import type { ModelClient, ModelEvent, ModelRequest, ModelToolCall } from '../../../model';
import type { McpToolReply } from '../../../mcp/tools';
import type { TaskTools } from '../taskTools';
import { foldTranscript, type LoadedTranscript, type TranscriptEntry, type TranscriptStore } from '../transcript';

/** One step's stream: its events, or a function that yields them and may wait on the signal. */
export type ScriptedStep = readonly ModelEvent[] | ((request: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>);

/** A ModelClient that plays one scripted stream per call and keeps every request it was sent. */
export function scriptedClient(steps: readonly ScriptedStep[]): ModelClient & { requests: ModelRequest[] } {
  const queue = [...steps];
  const requests: ModelRequest[] = [];
  return {
    provider: 'openrouter',
    dialect: 'chat-completions',
    requests,
    stream(request, signal) {
      requests.push(request);
      const step = queue.shift();
      if (!step) throw new Error('The script has no more steps.');
      if (typeof step === 'function') return step(request, signal ?? new AbortController().signal);
      return (async function* () {
        yield* step;
      })();
    },
  };
}

export function call(id: string, name: string, args: Record<string, unknown>): ModelEvent {
  const toolCall: ModelToolCall = { id, name, arguments: args, rawArguments: JSON.stringify(args) };
  return { type: 'tool-call-complete', call: toolCall };
}

export const STOP: ModelEvent = { type: 'finish', reason: 'stop' };

/** A transcript store in memory, folded the way the file store folds its lines. */
export class MemoryTranscriptStore implements TranscriptStore {
  readonly entries: TranscriptEntry[] = [];
  constructor(readonly sessionId = 'memory-session', readonly dir = '/nowhere/memory-session') {}
  async exists(): Promise<boolean> {
    return this.entries.length > 0;
  }
  async load(): Promise<LoadedTranscript> {
    return foldTranscript(this.entries);
  }
  async append(entry: TranscriptEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }
}

/** Task tools that answer with what `answer` returns, and note each call. */
export function fakeTaskTools(
  names: readonly string[],
  answer: (name: string, args: unknown, signal: AbortSignal) => Promise<McpToolReply> = async () => ({ text: 'ok' }),
): TaskTools & { calls: { name: string; args: unknown }[] } {
  const calls: { name: string; args: unknown }[] = [];
  return {
    calls,
    definitions: names.map((name) => ({ name, description: `the ${name} task tool`, parameters: { type: 'object', properties: {}, $schema: 'http://json-schema.org/draft-07/schema#' } })),
    has: (name) => names.includes(name),
    call: (name, args, signal) => {
      calls.push({ name, args });
      return answer(name, args, signal);
    },
  };
}

export function eventsOf<T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
