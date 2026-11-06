import type { LoginTerminal } from '../views/terminal/terminalStore';

/** Opens one agent's login in a terminal the person can see and type into (ADR-0052). */
export type OpenLoginTerminal = (runner: string, label: string) => Promise<LoginTerminal>;

let opener: OpenLoginTerminal | undefined;

/**
 * The terminal view owns the pty view; the session host only needs a way to
 * ask for one. Registering here keeps the session module free of the terminal
 * panel, whose tab strip mounts long before anyone signs in.
 */
export function setLoginTerminalOpener(next: OpenLoginTerminal | undefined): void {
  opener = next;
}

export async function openLoginTerminal(runner: string, label: string): Promise<LoginTerminal> {
  if (!opener) throw new Error('The login terminal is not available in this window.');
  return opener(runner, label);
}
