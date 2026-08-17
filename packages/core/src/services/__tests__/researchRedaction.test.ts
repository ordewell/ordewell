import { describe, it, expect } from 'vitest';
import { BaseAiService, type ResearchChat, type ResearchTurn, type ToolResult, type ConversationTurnContext } from '../BaseAiService';
import { executeTool } from '../executeTool';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';

/**
 * Redaction is applied once, where a tool result is constructed. These check
 * both ends of that claim: the construction point itself, and the two sinks
 * that must never see key material — the research log that becomes the
 * persisted session, and the tool results handed to the model provider.
 */

const DOTENV = [
  'DATABASE_URL=postgres://localhost:5432/app',
  'OPENAI_API_KEY=sk-proj-T3BlbkFJa1b2c3d4e5f6g7h8i9j0k1l2',
  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
].join('\n');

const SECRETS = ['sk-proj-T3BlbkFJ', 'AKIAIOSFODNN7EXAMPLE'];

class ScriptedChat implements ResearchChat {
  toolResultsSent: ToolResult[][] = [];
  constructor(private turns: ResearchTurn[]) {}
  async sendMessage(): Promise<ResearchTurn> {
    return this.turns.shift() ?? { text: 'done', toolCalls: [], hasToolCalls: false };
  }
  async sendToolResults(results: ToolResult[]): Promise<ResearchTurn> {
    this.toolResultsSent.push(results);
    return this.turns.shift() ?? { text: 'done', toolCalls: [], hasToolCalls: false };
  }
}

class TestService extends BaseAiService {
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(): Promise<string> { return ''; }
  runTurn(ctx: ConversationTurnContext, onProgress: (p: ResearchProgress) => void = () => {}) {
    return this.runConversationTurn(ctx, 'go', onProgress);
  }
}

describe('research output redaction', () => {
  it('redacts where the tool result is constructed', async () => {
    const fs = fakeFileSystem({ readFile: async () => ({ success: true, output: DOTENV, truncated: false }) });

    const outcome = await executeTool('read_file', { path: '.env' }, fs);

    for (const secret of SECRETS) expect(outcome.output).not.toContain(secret);
    expect(outcome.output).toContain('DATABASE_URL=postgres://localhost:5432/app');
    expect(outcome.output).toContain('OPENAI_API_KEY=[REDACTED');
  });

  it('keeps secrets out of both the persisted research log and the provider payload', async () => {
    const fs = fakeFileSystem({ readFile: async () => ({ success: true, output: DOTENV, truncated: false }) });
    const chat = new ScriptedChat([
      { text: '', toolCalls: [{ name: 'read_file', args: { path: '.env' }, id: '1' }], hasToolCalls: true },
      { text: 'done', toolCalls: [], hasToolCalls: false },
    ]);
    const progress: ResearchProgress[] = [];

    const turn = await new TestService(fakeConfig()).runTurn(
      { chat, fs, runners: ['claude-code'] },
      (p) => progress.push(p),
    );

    // Persisted sink: the research log is what saveSession writes to disk.
    const logged = turn.researchLog.map((entry) => JSON.stringify(entry)).join('\n');
    // Provider sink: what the next request actually carries.
    const sent = chat.toolResultsSent.flat().map((r) => r.output).join('\n');
    // Live sink: what every surface renders while research runs.
    const streamed = progress.map((p) => JSON.stringify(p)).join('\n');

    for (const secret of SECRETS) {
      expect(logged, 'research log').not.toContain(secret);
      expect(sent, 'provider payload').not.toContain(secret);
      expect(streamed, 'progress stream').not.toContain(secret);
    }
    expect(sent).toContain('[REDACTED');
    expect(logged).toContain('[REDACTED');
  });
});
