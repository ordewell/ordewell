import type { IConfig } from './interfaces/IConfig';
import type { IFileSystem, ToolOutcome } from './interfaces/IFileSystem';
import type { ITerminalSession } from './interfaces/ITerminalRunner';

export function fakeConfig(overrides: Partial<IConfig> = {}): IConfig {
  return {
    aiProvider: 'openrouter',
    apiKey: 'sk-test',
    planningModel: 'test-model',
    enabledRunners: ['claude-code'],
    maxParallelSessions: 3,
    researchEnabled: false,
    researchMaxSteps: 10,
    researchMaxFileSize: 100_000,
    openAiBaseUrl: 'https://api.openai.com/v1',
    openAiApiKey: '',
    openrouterKey: '',
    geminiKey: '',
    openaiCompatibleBaseUrl: '',
    openaiCompatibleApiKey: '',
    orchestratorModel: '',
    researchSubagentModel: '',
    geminiModel: '',
    planMapEnabled: true,
    autonomousMode: true,
    approvalMode: 'ask',
    approvalPreApproved: [],
    setProviderModelLists: () => {},
    getProviderBaseUrl: () => '',
    getProviderApiKey: () => '',
    ...overrides,
  };
}

const EMPTY_OUTCOME: ToolOutcome = { success: false, output: '', truncated: false };

/**
 * A complete {@link IFileSystem} stub. Lives here rather than in each package's
 * test folder so adding a tool to the interface is one edit, not one per suite.
 */
export function fakeFileSystem(overrides: Partial<IFileSystem> = {}): IFileSystem {
  return {
    readFile: async () => EMPTY_OUTCOME,
    readFiles: async () => EMPTY_OUTCOME,
    glob: async () => EMPTY_OUTCOME,
    grep: async () => EMPTY_OUTCOME,
    findSymbol: async () => EMPTY_OUTCOME,
    listDir: async () => EMPTY_OUTCOME,
    bash: async () => EMPTY_OUTCOME,
    getWorkspaceRoot: () => '/workspace',
    ...overrides,
  };
}

export class FakeTerminalSession implements ITerminalSession {
  private outputCbs: Array<(text: string) => void> = [];
  private exitCbs: Array<(code: number) => void> = [];
  output = '';
  written: string[] = [];
  killed = false;

  constructor(public id = 's1', public taskId = 't1') {}

  onOutput(cb: (text: string) => void): void { this.outputCbs.push(cb); }
  onExit(cb: (code: number) => void): void { this.exitCbs.push(cb); }
  kill(): void { this.killed = true; }
  getOutput(): string { return this.output; }
  write(text: string): void { this.written.push(text); }

  emitOutput(text: string): void {
    this.output += text;
    for (const cb of this.outputCbs) cb(text);
  }
  emitExit(code: number): void {
    for (const cb of this.exitCbs) cb(code);
  }
}
