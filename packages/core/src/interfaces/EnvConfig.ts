import { BaseConfig } from './BaseConfig';
import type { AiProvider } from './IConfig';

/**
 * A fully `process.env`-backed IConfig for headless callers (e.g. the CLI's
 * `ordewell models` command) that need provider keys/base URLs but have no
 * editor settings or secret store. All resolution lives in BaseConfig; this
 * subclass only supplies the abstract members from the environment.
 */
export class EnvConfig extends BaseConfig {
  get aiProvider(): AiProvider {
    return BaseConfig.detectProvider('openrouter');
  }

  get apiKey(): string {
    return this.getProviderApiKey(this.aiProvider) || this.openrouterKey || this.geminiKey || '';
  }

  get planningModel(): string {
    return this.orchestratorModel;
  }

  get enabledRunners(): string[] {
    const raw = process.env.ORDEWELL_RUNNERS || process.env.ENABLED_RUNNERS || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // The CLI does not persist routing lists; resolution happens per-invocation.
  setProviderModelLists(): void {}
}
