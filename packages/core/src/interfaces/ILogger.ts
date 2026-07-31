export interface ILogger {
  warn(scope: string, message: string, err?: unknown): void;
}

export class ConsoleLogger implements ILogger {
  warn(scope: string, message: string, err?: unknown): void {
    const detail = err === undefined ? '' : ` :: ${formatError(err)}`;
    console.warn(`[${scope}] ${message}${detail}`);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export const defaultLogger: ILogger = new ConsoleLogger();
