import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { IRunnerSession } from '../../interfaces/IRunner';

/**
 * Adversarial, round two, on the plain-text channel (ADR-0018, O1a): the
 * first round fixed one late tail gluing onto a later run's text. The
 * neighbouring cases: two late tails in a row, a tail arriving at line
 * start, a tool line of the channel's own in between, and a copy that
 * disagrees with its deltas after another run spoke.
 */

class OpenAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId: string = 'codex';
  readonly exited = false;
  readonly sent: string[] = [];
  private turn: { onEvent: (event: AgentEvent) => void; resolve: () => void } | null = null;

  async start(_opts: AgentStartOptions): Promise<void> {}
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  emit(...events: AgentEvent[]): void { for (const event of events) this.turn?.onEvent(event); }
  end(): void { this.turn?.resolve(); }
  async interrupt(): Promise<boolean> { return false; }
  onOutOfTurn(_listener: (event: AgentEvent) => void): void {}
  onProcessExit(_listener: (code: number) => void): void {}
  answerPermission(_id: string, _decision: never): boolean { return false; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

const registry = new RunnerRegistry();
const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

async function session(): Promise<{ adapter: OpenAdapter; output: () => string; endTurn: () => Promise<void> }> {
  const adapters: OpenAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new OpenAdapter();
      adapters.push(adapter);
      return adapter;
    },
  });
  runners.push(runner);
  const session = (await runner.spawn({
    taskId: 'task-0042-plain', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry,
  })) as IRunnerSession;
  const adapter = adapters[0];
  await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
  let ended = false;
  session.onTurnEnd(() => { ended = true; });
  const endTurn = async () => {
    adapter.end();
    await vi.waitFor(() => expect(ended).toBe(true));
  };
  return { adapter, output: () => session.getOutput(), endTurn };
}

describe('the plain-text channel when several runs settle out of order', () => {
  it('starts each of two late tails on its own line, after each had something written since', async () => {
    const { adapter, output, endTurn } = await session();

    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'One\n' },
      { type: 'assistant_text_delta', runId: 'r2', text: 'Two\n' },
      { type: 'assistant_text_delta', runId: 'r3', text: 'Three' },
      // Each run's authoritative copy lands after a later run spoke.
      { type: 'assistant_text', runId: 'r1', text: 'One\n 1' },
      { type: 'assistant_text', runId: 'r2', text: 'Two\n 2' },
      { type: 'assistant_text', runId: 'r3', text: 'Three 3' },
    );
    // The session holds its MCP token, so text that ends on what could begin a
    // part of it is held back until more comes or the turn ends (ADR-0061, H1).
    await endTurn();

    const out = output();
    expect(out).toContain('Three\n 1\n 2\n 3');
    expect(out).not.toContain('Three 1');
    expect(out).not.toContain(' 1 2');
  });

  it('starts a late tail at the line its run last reached, with no blank line punched in', async () => {
    const { adapter, output, endTurn } = await session();

    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'One\n' },
      { type: 'assistant_text', runId: 'r2', text: 'Two\n' },
      { type: 'assistant_text', runId: 'r1', text: 'One\ntail' },
    );
    await endTurn();

    expect(output()).toContain('Two\ntail');
    expect(output()).not.toContain('Two\n\ntail');
  });

  it('starts a late tail on a new line when a tool line of the channel followed its deltas', async () => {
    const { adapter, output, endTurn } = await session();

    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'Looking\n' },
      { type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'ls' } },
      { type: 'assistant_text', runId: 'r1', text: 'Looking\nat the tree' },
    );
    await endTurn();

    const out = output();
    expect(out).toContain('› shell(ls)');
    expect(out).toMatch(/› shell\(ls\)\nat the tree/);
    expect(out).not.toContain('› shell(ls)at the tree');
  });

  it('starts a copy that disagrees with its deltas on its own line, after another run spoke', async () => {
    const { adapter, output } = await session();

    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'Checking\n' },
      { type: 'assistant_text', runId: 'r2', text: 'Two lines.' },
      // The stream lost a frame: the copy does not extend the deltas.
      { type: 'assistant_text', runId: 'r1', text: 'Checking the tree.' },
    );

    const out = output();
    expect(out).toContain('Two lines.\nChecking the tree.');
    expect(out).not.toContain('Two lines.Checking');
  });
});
