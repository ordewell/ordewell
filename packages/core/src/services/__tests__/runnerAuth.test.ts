import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunnerAuth, recordRunnerAuth, resetRunnerAuth, signedOutFromFailure, type RunnerAuthExec } from '../runnerAuth';
import { plannerNotReadyFor } from '../plannerReadiness';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import { COPILOT_CLI_MANIFEST } from '../../plugins/builtin/copilot-cli.manifest';
import type { LaunchDeps } from '../../utils/launch';

type Answer = { code: number; stdout?: string; stderr?: string };

function execAnswering(answer: Answer): RunnerAuthExec & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    code: answer.code,
    stdout: answer.stdout ?? '',
    stderr: answer.stderr ?? '',
  })) as unknown as RunnerAuthExec & ReturnType<typeof vi.fn>;
}

/** A CODEX_HOME: the config file sits directly in it. */
function codexHome(config: string): string {
  const home = mkdtempSync(join(tmpdir(), 'ordewell-codex-home-'));
  writeFileSync(join(home, 'config.toml'), config);
  return home;
}

/** A fake HOME: Codex's default config path is `$HOME/.codex/config.toml`. */
function codexHomed(config: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ordewell-codex-root-'));
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex', 'config.toml'), config);
  return root;
}

const AZURE_PROVIDER = [
  'model = "gpt-5.4"',
  'model_provider = "azure"',
  '[model_providers.azure]',
  'name = "Azure"',
  'base_url = "https://example.openai.azure.com/openai/v1"',
  'env_key = "AZURE_OPENAI_API_KEY"',
  'wire_api = "responses"',
  '',
].join('\n');

describe('readRunnerAuth', () => {
  it('asks the runner its own status command and reads Claude signed in from a clean exit', async () => {
    const exec = execAnswering({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'signed-in',
      loginCommand: ['claude', 'auth', 'login'],
    });
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status'], expect.anything());
  });

  it('reads Claude signed out from the JSON its status command prints on failure', async () => {
    // The shape `claude auth status` prints when the user logged out, observed on a signed-out host.
    const exec = execAnswering({
      code: 1,
      stdout: '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n',
    });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
  });

  it('reads Claude signed out from the JSON on stdout even when stderr carries a warning', async () => {
    // A CLI may warn on stderr (an update nudge, a config notice) beside the
    // JSON answer; the reader must not parse the two together as one document.
    const exec = execAnswering({
      code: 1,
      stdout: '{"loggedIn":false,"authMethod":"none"}\n',
      stderr: 'Warning: a newer Claude Code is available\n',
    });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
  });

  it('keeps an older Claude whose status output does not parse unknown, not signed out', async () => {
    const exec = execAnswering({ code: 1, stdout: 'error: unknown command auth', stderr: '' });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'unknown',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it('reads Codex signed out from its own status line', async () => {
    // `codex login status` prints this and exits 1 on a signed-out host.
    const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });

    expect(await readRunnerAuth(CODEX_MANIFEST, { exec })).toEqual({
      state: 'signed-out',
      loginCommand: ['codex', 'login'],
      detail: 'not logged in',
    });
    expect(exec).toHaveBeenCalledWith('codex', ['login', 'status'], expect.anything());
  });

  it('reads Codex signed in from a clean status exit', async () => {
    const exec = execAnswering({ code: 0, stdout: 'Logged in using ChatGPT\n' });

    expect(await readRunnerAuth(CODEX_MANIFEST, { exec })).toEqual({
      state: 'signed-in',
      loginCommand: ['codex', 'login'],
    });
  });

  it('reports unknown when the binary is missing or the status command times out', async () => {
    const missing: RunnerAuthExec = vi.fn(async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec: missing })).toEqual({
      state: 'unknown',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it("runs the status command with the supplied workspace environment over the daemon's own", async () => {
    const exec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));

    await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec, env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-b' } });

    const options = vi.mocked(exec).mock.calls[0][2];
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-b');
    expect(options.env.PATH).toBeTruthy();
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("never throws when a runner's own reader fails", async () => {
    const manifest = {
      ...CLAUDE_CODE_MANIFEST,
      auth: { statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login'], read: () => { throw new Error('boom'); } },
    };
    const exec = execAnswering({ code: 0, stdout: '{}' });

    expect(await readRunnerAuth(manifest, { exec })).toEqual({
      state: 'unknown',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it('reports a runner with no status command unknown and offers it no login', async () => {
    const exec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    expect(await readRunnerAuth(OPENCODE_MANIFEST, { exec })).toEqual({ state: 'unknown' });
    expect(exec).not.toHaveBeenCalled();
  });

  // Copilot has `copilot login` and no status command, so nothing can be asked:
  // the verdict stays unknown until a failed turn says otherwise, and the login
  // command is still offered for the surfaces that run it.
  it('runs nothing for a runner with a login but no status command, and offers its login', async () => {
    const exec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    expect(await readRunnerAuth(COPILOT_CLI_MANIFEST, { exec })).toEqual({ state: 'unknown', loginCommand: ['copilot', 'login'] });
    expect(exec).not.toHaveBeenCalled();
  });

  // `codex login status` only knows the credentials Codex itself stores. A
  // custom `model_provider` (Azure, an enterprise gateway, Bedrock) carries its
  // own credential in config.toml, so the command's "Not logged in" says
  // nothing about whether Codex can plan. Recording it as signed-out walls a
  // working enterprise setup behind an irrelevant `codex login`.
  describe('Codex with its own model provider', () => {
    const gate = () => plannerNotReadyFor({
      aiProvider: 'codex', orchestratorModel: '', planningModel: '', openaiCompatibleBaseUrl: '',
      getProviderApiKey: () => '',
    });

    afterEach(() => resetRunnerAuth());

    it('leaves a custom provider whose key comes from the environment unknown, so the gate lets it plan', async () => {
      const home = codexHome([
        'model = "gpt-5.4"',
        'model_provider = "azure"',
        '[model_providers.azure]',
        'name = "Azure"',
        'base_url = "https://example.openai.azure.com/openai/v1"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join('\n'));
      try {
        const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
        const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: home, AZURE_OPENAI_API_KEY: 'sk-test' } });

        expect(auth).toEqual({ state: 'unknown', loginCommand: ['codex', 'login'] });
        recordRunnerAuth('codex', auth);
        expect(gate()).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('leaves a provider authenticated by env headers or an auth helper unknown too', async () => {
      for (const table of [
        'env_http_headers = { "x-api-key" = "GATEWAY_KEY" }',
        'auth = { command = "print-token" }',
      ]) {
        const home = codexHome(['model_provider = "gateway"', '[model_providers.gateway]', 'name = "Gateway"', 'base_url = "https://gateway.example/v1"', table, ''].join('\n'));
        try {
          const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
          const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: home } });
          expect(auth.state).toBe('unknown');
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    });

    it('leaves the default provider unknown when OPENAI_API_KEY is set, so the gate lets it plan', async () => {
      // Codex authenticates with this key while `codex login status` still
      // only reports its own stored login. A real key is not a signed-out host.
      const home = codexHome('model = "gpt-5.4"\n');
      try {
        const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
        const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: home, OPENAI_API_KEY: 'sk-test' } });

        expect(auth).toEqual({ state: 'unknown', loginCommand: ['codex', 'login'] });
        recordRunnerAuth('codex', auth);
        expect(gate()).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('leaves a credential-less local provider unknown, so the gate lets it plan', async () => {
      // Ollama and LM Studio authenticate with nothing; the provider's
      // base_url is the only setting. Codex's login has no say over it.
      const home = codexHome([
        'model = "local-model"',
        'model_provider = "local"',
        '[model_providers.local]',
        'name = "Local"',
        'base_url = "http://127.0.0.1:11434/v1"',
        '',
      ].join('\n'));
      try {
        const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
        const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: home } });

        expect(auth).toEqual({ state: 'unknown', loginCommand: ['codex', 'login'] });
        recordRunnerAuth('codex', auth);
        expect(gate()).toBeNull();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('keeps a default setup with no credential genuinely signed out, and the gate refuses it', async () => {
      const home = codexHome('model = "gpt-5.4"\n');
      try {
        const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
        const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: home } });

        expect(auth).toEqual({ state: 'signed-out', loginCommand: ['codex', 'login'], detail: 'not logged in' });
        recordRunnerAuth('codex', auth);
        expect(gate()).toMatchObject({ code: 'signed_out', runner: 'codex' });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('keeps a custom provider that still signs in through Codex itself signed out', async () => {
      // `requires_openai_auth` delegates to the login the status command asks
      // about, so its "Not logged in" is this user's answer.
      const home = codexHome([
        'model_provider = "azure"',
        '[model_providers.azure]',
        'name = "Azure"',
        'base_url = "https://example.openai.azure.com/openai/v1"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'requires_openai_auth = true',
        '',
      ].join('\n'));
      try {
        const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
        const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: home } });
        expect(auth.state).toBe('signed-out');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    // Without CODEX_HOME, real codex resolves `$HOME/.codex/config.toml` — the
    // environment the probe hands it, not the daemon's. A workspace that sets
    // HOME in `.ordewell/env` points the config lookup there (ADR-0016).
    describe('the fallback config home is the probe environment HOME', () => {
      it('leaves a custom provider whose config sits under HOME unknown, not signed out', async () => {
        const home = codexHomed([
          'model = "gpt-5.4"',
          'model_provider = "azure"',
          '[model_providers.azure]',
          'name = "Azure"',
          'base_url = "https://example.openai.azure.com/openai/v1"',
          'env_key = "AZURE_OPENAI_API_KEY"',
          'wire_api = "responses"',
          '',
        ].join('\n'));
        try {
          const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
          const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { HOME: home, AZURE_OPENAI_API_KEY: 'sk-test' } });

          expect(auth).toEqual({ state: 'unknown', loginCommand: ['codex', 'login'] });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });

      it('treats an empty CODEX_HOME as unset and falls back to HOME, as codex does', async () => {
        const home = codexHomed([
          'model_provider = "gateway"',
          '[model_providers.gateway]',
          'name = "Gateway"',
          'base_url = "https://gateway.example/v1"',
          'env_http_headers = { "x-api-key" = "GATEWAY_KEY" }',
          '',
        ].join('\n'));
        try {
          const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
          const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { CODEX_HOME: '', HOME: home } });

          expect(auth.state).toBe('unknown');
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });

      it('keeps a default setup under HOME genuinely signed out', async () => {
        const home = codexHomed('model = "gpt-5.4"\n');
        try {
          const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
          const auth = await readRunnerAuth(CODEX_MANIFEST, { exec, env: { HOME: home } });

          expect(auth).toEqual({ state: 'signed-out', loginCommand: ['codex', 'login'], detail: 'not logged in' });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    });
  });

  // A timeout is not an answer: execFile kills the child and hands back no
  // exit status, so whatever it printed before hanging must not be judged.
  it.skipIf(process.platform === 'win32')('reports unknown, not signed out, when a status probe times out after printing its line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-auth-timeout-'));
    const cli = join(dir, 'codex');
    writeFileSync(cli, '#!/bin/sh\necho "Not logged in" >&2\nexec sleep 5\n');
    chmodSync(cli, 0o755);
    try {
      const manifest = { ...CODEX_MANIFEST, runner: { command: cli } };

      expect(await readRunnerAuth(manifest, { timeoutMs: 1000 })).toEqual({
        state: 'unknown',
        loginCommand: [cli, 'login'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  // `execFile`'s timeout only sends SIGTERM and waits. A status command that
  // ignores it (and holds its pipes open through a child) must not keep the
  // probe -- and with it the runner list and a planner turn -- pending.
  it.skipIf(process.platform === 'win32')('settles within its budget when the status child ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-auth-stubborn-'));
    const cli = join(dir, 'codex');
    writeFileSync(cli, '#!/bin/sh\ntrap "" TERM\necho "Not logged in" >&2\nsleep 5\n');
    chmodSync(cli, 0o755);
    try {
      const manifest = { ...CODEX_MANIFEST, runner: { command: cli } };
      const started = Date.now();

      expect(await readRunnerAuth(manifest, { timeoutMs: 500 })).toEqual({
        state: 'unknown',
        loginCommand: [cli, 'login'],
      });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // An npm install on Windows is a `.cmd` shim, which a bare execFile cannot
  // find or start, so the probe has to be started the way the planner is.
  describe('on Windows', () => {
    const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
    const windows = (files: string[]): LaunchDeps => {
      const present = new Set(files.map((f) => f.toLowerCase()));
      return {
        platform: 'win32',
        resolvePath: async () => `C:\\tools;${NPM}`,
        exists: (candidate) => present.has(candidate.toLowerCase()),
        comSpec: () => 'C:\\Windows\\System32\\cmd.exe',
        powerShell: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        pathExt: () => '.COM;.EXE;.BAT;.CMD',
      };
    };

    it('asks an npm-installed agent through cmd.exe, with the line passed verbatim', async () => {
      const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });
      const home = codexHome('');
      try {
        const auth = await readRunnerAuth(CODEX_MANIFEST, {
          exec, env: { CODEX_HOME: home }, launch: windows([`${NPM}\\codex.cmd`, `${NPM}\\codex.ps1`]),
        });

        expect(auth.state).toBe('signed-out');
        expect(exec).toHaveBeenCalledWith(
          'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/s', '/c', `"${NPM}\\codex.cmd login status"`],
          expect.objectContaining({ verbatim: true }),
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('starts a native executable directly', async () => {
      const exec = execAnswering({ code: 0, stdout: '{"loggedIn":true}' });

      await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec, launch: windows(['C:\\tools\\claude.exe']) });

      expect(exec).toHaveBeenCalledWith('C:\\tools\\claude.exe', ['auth', 'status'], expect.not.objectContaining({ verbatim: true }));
    });

    it.runIf(process.platform === 'win32')('reads a real .cmd shim signed out', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ordewell-auth-shim-'));
      const home = codexHome('');
      writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\necho Not logged in\r\nexit /b 1\r\n');
      try {
        const auth = await readRunnerAuth(CODEX_MANIFEST, {
          env: { CODEX_HOME: home }, launch: { resolvePath: async () => dir },
        });

        expect(auth).toEqual({ state: 'signed-out', loginCommand: ['codex', 'login'], detail: 'not logged in' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe('signedOutFromFailure', () => {
  it("reads the runner's own not-logged-in words as signed out, with its login command", () => {
    expect(signedOutFromFailure(CLAUDE_CODE_MANIFEST, 'Not logged in · Please run /login')).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
  });

  it('keeps a default Codex setup signed out from its failure line', () => {
    const home = codexHomed('model = "gpt-5.4"\n');
    try {
      expect(signedOutFromFailure(CODEX_MANIFEST, 'Not logged in\n', { HOME: home })).toEqual({
        state: 'signed-out',
        loginCommand: ['codex', 'login'],
        detail: 'not logged in',
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('judges a Codex failure through its reader and the workspace env, so a custom provider is not a login wall', () => {
    const home = codexHomed(AZURE_PROVIDER);
    try {
      expect(signedOutFromFailure(CODEX_MANIFEST, 'Not logged in\n', { HOME: home, AZURE_OPENAI_API_KEY: 'sk-test' })).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads the ACP agent's auth-required error as Copilot signed out, with `copilot login`", () => {
    expect(signedOutFromFailure(COPILOT_CLI_MANIFEST, 'Authentication required')).toEqual({
      state: 'signed-out',
      loginCommand: ['copilot', 'login'],
      detail: 'not logged in',
    });
    // The adapter's own words for the same error, which is what a task's failure carries.
    expect(signedOutFromFailure(COPILOT_CLI_MANIFEST, 'GitHub Copilot CLI is not signed in. Run `copilot login`.')?.state).toBe('signed-out');
  });

  it('leaves an unrelated Copilot failure unjudged', () => {
    expect(signedOutFromFailure(COPILOT_CLI_MANIFEST, 'gh: You are not logged in to any GitHub hosts.')).toBeUndefined();
    expect(signedOutFromFailure(COPILOT_CLI_MANIFEST, 'Model not available')).toBeUndefined();
  });

  it('leaves an unrelated failure, and a runner that declares no login, unjudged', () => {
    expect(signedOutFromFailure(CLAUDE_CODE_MANIFEST, 'The repository is not a git repository')).toBeUndefined();
    expect(signedOutFromFailure(OPENCODE_MANIFEST, 'Not logged in · Please run /login')).toBeUndefined();
  });

  // The phrase alone is not the runner's own verdict: a failed turn may quote
  // another tool (GitHub CLI, an MCP server) that is not logged in. Recording
  // that as the agent's state walls the planner until the next probe.
  it('leaves an unrelated failure that merely mentions a login elsewhere', () => {
    const passage = 'gh: You are not logged in to any GitHub hosts.';
    expect(signedOutFromFailure(CLAUDE_CODE_MANIFEST, passage)).toBeUndefined();
    expect(signedOutFromFailure(CODEX_MANIFEST, passage)).toBeUndefined();
  });

  it("never throws when a runner's reader cannot judge a failure", () => {
    const manifest = {
      ...CLAUDE_CODE_MANIFEST,
      auth: { statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login'], read: () => { throw new Error('boom'); } },
    };

    expect(signedOutFromFailure(manifest, 'anything')).toBeUndefined();
  });
});
