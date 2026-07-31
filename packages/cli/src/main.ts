#!/usr/bin/env node
import { loadEnvFile } from './utils/env';
import { printHelp } from './help';
import { describeConnectionRefused, isConnectionRefused, resolvePort } from './daemonClient';
import { COMMANDS } from './commands/registry';

async function main(): Promise<void> {
  loadEnvFile();
  const argv = process.argv.slice(2);
  // Bare `ordewell` opens the TUI — it is the product's front door, not a usage
  // error. Pipes and scripts still get help, since the TUI needs a real
  // terminal and would otherwise exit 1 on `ordewell | less`.
  const command = argv[0] ?? (process.stdin.isTTY ? 'tui' : '--help');
  if (command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run `ordewell --help` for usage.');
    process.exit(1);
  }
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
