import { runUpdate } from '../selfUpdate';

/** `ordewell update [--dry-run]` (ADR-0048): exits with the status of what it ran. */
export async function handleUpdate(args: string[]): Promise<void> {
  process.exitCode = await runUpdate(args);
}
