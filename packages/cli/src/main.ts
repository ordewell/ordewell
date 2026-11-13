#!/usr/bin/env node
import { resolve } from 'path';
import { migrateOldConfigDir } from '@ordewell/core';
import { loadEnvFile, moveAutonomyToSettings } from './utils/env';
import { printCommandHelp, printHelp } from './help';
import { describeConnectionRefused, isConnectionRefused, resolvePort } from './daemon';
import { ApiClient } from './apiClient';
import { COMMANDS } from './commands/registry';
import { cliVersion } from './version';
import { startHeadlessVersionCheck } from './versionCheck';
import { expandSessionId, flag } from './utils';
import { wantsHelp } from './utils/args';
import { suggestForLongDash } from './utils/longDash';

const TUI_FLAGS = new Set(['--workspace', '--port']);

async function main(): Promise<void> {
  // Before loadEnvFile() reads from the new location, so a pre-`.ordewell`
  // install's API keys are there to find.
  migrateOldConfigDir();
  moveAutonomyToSettings();
  loadEnvFile();
  const argv = process.argv.slice(2);
  // Bare `ordewell` opens the TUI — it is the product's front door, not a usage
  // error. Pipes and scripts still get help, since the TUI needs a real
  // terminal and would otherwise exit 1 on `ordewell | less`.
  // `ordewell --workspace x` / `ordewell --port N` are the TUI options the help
  // lists under a bare `ordewell`, so a leading TUI flag still means the TUI.
  if (TUI_FLAGS.has(argv[0] ?? '')) argv.unshift('tui');
  const command = argv[0] ?? (process.stdin.isTTY ? 'tui' : '--help');
  if (command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(cliVersion());
    return;
  }
  // Resolved once, so a daemon that runs in another directory never resolves a
  // relative `--workspace` against its own cwd.
  ApiClient.defaultWorkspace = resolve(flag(argv, '--workspace') || process.cwd());
  const sessionAt = argv.indexOf('--session-id');
  if (sessionAt > 0 && argv[sessionAt + 1]) {
    argv[sessionAt + 1] = expandSessionId(argv[sessionAt + 1], flag(argv, '--workspace') || process.cwd());
  }
  // hasOwn: `constructor` and `toString` are not commands, whatever the
  // object's prototype says.
  const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    const suggestion = suggestForLongDash(command);
    if (suggestion) {
      console.error(
        `Did you mean ${suggestion}? It starts with a long dash (${command[0]}) where -- was meant; some keyboards and apps make that change.`,
      );
    }
    console.error('Run `ordewell --help` for usage.');
    process.exit(1);
    return;
  }
  // `--help` among a command's arguments is a request for help, whatever the
  // command: it never reaches the handler, which would act on it or ignore it.
  if (wantsHelp(argv.slice(1))) {
    printCommandHelp(command);
    return;
  }
  // The TUI starts its own, to draw it in its frame: one check per start either
  // way. `update` asks the tool it runs for the latest, and never pings (ADR-0048).
  if (command !== 'tui' && command !== 'update') startHeadlessVersionCheck();
  try {
    await handler(argv.slice(1));
  } catch (err) {
    // Every command that talks to the daemon calls `ensureDaemon` first, so a
    // refusal here means it died mid-command. `connect ECONNREFUSED
    // 127.0.0.1:3742` names a socket; this names something the user can do.
    console.error(
      isConnectionRefused(err)
        ? `Fatal: ${describeConnectionRefused(resolvePort(argv.slice(1)))}`
        : `Fatal: ${(err as Error)?.message ?? err}`,
    );
    process.exit(1);
  }
}

main();
