import { describe, it, expect } from 'vitest';
import { BaseAiService, type ResearchChat, type ResearchTurn, type ToolResult, type ConversationTurnContext } from '../BaseAiService';
import { executeTool } from '../executeTool';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import { fakeSecret } from './fakeSecret';

/**
 * Redaction is applied once, where a tool result is constructed. These check
 * both ends of that claim: the construction point itself, and the two sinks
 * that must never see key material — the research log that becomes the
 * persisted session, and the tool results handed to the model provider.
 */

const DOTENV = [
  'DATABASE_URL=postgres://localhost:5432/app',
  `OPENAI_API_KEY=${fakeSecret('openai')}`,
  `AWS_ACCESS_KEY_ID=${fakeSecret('aws')}`,
].join('\n');

const SECRETS = ['sk-proj-T3BlbkFJ', fakeSecret('aws')];

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

  describe('private keys and auth headers, in every form a file or a command can hold them', () => {
    /** Distinct base64 lines that encode nothing; `FAKEpem` marks any of them that got through. */
    const body = Array.from({ length: 30 }, (_, i) => `FAKEpem${String(i).padStart(3, '0')}`.padEnd(64, 'QWERTYuiop0123456789+/asdfGHJKLzxcvbnm'));
    const pem = `-----BEGIN PRIVATE KEY-----\n${body.join('\n')}\n-----END PRIVATE KEY-----`;
    const numbered = (text: string, from = 1) => text.split('\n').map((line, i) => `${String(from + i).padStart(6)}|${line}`).join('\n');
    const read = (output: string) =>
      executeTool('read_file', { path: 'f' }, fakeFileSystem({ readFile: async () => ({ success: true, output, truncated: false }) })).then((o) => o.output);

    it('redacts a key block read whole', async () => {
      const output = await read(numbered(pem));
      expect(output).not.toContain('FAKEpem');
      expect(output).toContain('-----END PRIVATE KEY-----');
    });

    it('redacts the body of a key read from its middle, with no BEGIN line to start from', async () => {
      const middle = pem.split('\n').slice(12).join('\n');
      for (const output of [await read(middle), await read(numbered(middle, 13))]) {
        expect(output).not.toContain('FAKEpem');
        expect(output).toContain('-----END PRIVATE KEY-----');
        expect(output).toContain('[REDACTED private key');
      }
    });

    it('redacts a key escaped onto one line of a service-account file', async () => {
      const file = JSON.stringify({ type: 'service_account', private_key: `${pem}\n`, client_email: 'x@fake-proj.iam.gserviceaccount.com' }, null, 2);
      const output = await read(numbered(file));
      expect(output).not.toContain('FAKEpem');
      expect(output).toContain('x@fake-proj.iam.gserviceaccount.com');
    });

    it('redacts a Bearer token a script sends, and leaves code that only names one', async () => {
      const token = 'zX9cV7bN5mQ3wE1rT9yU7iO5pA3sD1fGfake';
      const script = [
        `curl -H "Authorization: Bearer ${token}" https://api.example.com/v1`,
        'const password = passwordField.value;',
        'headers.Authorization = `Bearer ${apiToken}`;',
      ].join('\n');
      const output = await read(numbered(script));
      expect(output).not.toContain(token.slice(0, 8));
      expect(output).toContain('Bearer [REDACTED token');
      expect(output).toContain('const password = passwordField.value;');
      expect(output).toContain('headers.Authorization = `Bearer ${apiToken}`;');
    });

    it('keeps an escaped key out of the research log, the provider payload and the progress stream', async () => {
      const file = JSON.stringify({ private_key: `${pem}\n` });
      const fs = fakeFileSystem({ readFile: async () => ({ success: true, output: file, truncated: false }) });
      const chat = new ScriptedChat([
        { text: '', toolCalls: [{ name: 'read_file', args: { path: 'sa.json' }, id: '1' }], hasToolCalls: true },
        { text: 'done', toolCalls: [], hasToolCalls: false },
      ]);
      const progress: ResearchProgress[] = [];
      const turn = await new TestService(fakeConfig()).runTurn({ chat, fs, runners: ['claude-code'] }, (p) => progress.push(p));
      expect(turn.researchLog.map((entry) => JSON.stringify(entry)).join('\n'), 'research log').not.toContain('FAKEpem');
      expect(chat.toolResultsSent.flat().map((r) => r.output).join('\n'), 'provider payload').not.toContain('FAKEpem');
      expect(progress.map((p) => JSON.stringify(p)).join('\n'), 'progress stream').not.toContain('FAKEpem');
    });
  });
});
