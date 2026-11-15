import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RouteId } from '../shared/routes';

const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 1000;
const STARTUP_READS: ReadonlySet<RouteId> = new Set([
  'runners.list', 'models.list', 'settings.get', 'sessions.list', 'sessions.get',
  'git.repos', 'git.status', 'files.tree', 'workspaces.isolationPreview',
]);

/** Timings only: route ids and lifecycle stages, never query strings, bodies or project paths. */
export class StartupLog {
  private pending: Promise<void>;
  private count = 0;

  constructor(private readonly file: string) {
    this.pending = (async () => {
      await mkdir(dirname(file), { recursive: true });
      const existing = await stat(file).catch(() => undefined);
      if (existing && existing.size >= MAX_BYTES) await rename(file, `${file}.previous`);
    })().catch(() => {});
  }

  record(stage: string, fields: Record<string, string | number | boolean> = {}): void {
    if (this.count++ >= MAX_EVENTS) return;
    const line = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, sinceLaunchMs: Math.round(process.uptime() * 1000), stage, ...fields });
    // Disk trouble must neither block the window nor stop the app. Serial
    // writes preserve the order even when the first one is still opening it.
    this.pending = this.pending.then(() => appendFile(this.file, `${line}\n`, { mode: 0o600 })).catch(() => {});
  }

  request(route: RouteId): ((ok: boolean) => void) | undefined {
    if (!STARTUP_READS.has(route)) return undefined;
    const started = performance.now();
    this.record('request.started', { route });
    return (ok) => this.record('request.finished', { route, ok, durationMs: Math.round(performance.now() - started) });
  }

  /** Let a polite quit finish the queued writes. */
  flush(): Promise<void> {
    return this.pending;
  }
}
