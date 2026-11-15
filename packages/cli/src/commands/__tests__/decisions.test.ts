import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';
import { stripAnsi } from '../../tui/ansi';

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  readLastSession: () => ({ sessionId: 'session-1', goal: 'g', runners: ['claude-code'], workspace: '/tmp/ws' }),
}));

function daemon(plan: unknown): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plan, goal: 'g' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }));
  });
}

async function decisions(args: string[], plan: unknown): Promise<{ stdout: string; exitCode: number | null; stderr: string }> {
  const srv = await daemon(plan);
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
  let exitCode: number | null = null;
  try {
    const { handleDecisions } = await import('../decisions');
    await handleDecisions(['--workspace', '/tmp/ws', ...args], new ApiClient(srv.port));
  } catch (e: unknown) {
    const match = ((e as Error).message || '').match(/^exit:(\d+)$/);
    if (!match) throw e;
    exitCode = parseInt(match[1], 10);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    srv.close();
  }
  return { stdout: stripAnsi(logs.join('\n')), stderr: stripAnsi(errs.join('\n')), exitCode };
}

const RECORD = [
  { id: 'D1', kind: 'decision', text: 'Use SQLite', why: 'one file, no server' },
  { id: 'D2', kind: 'decision', text: 'Use Postgres', why: 'we need concurrent writers', supersedes: 'D1' },
  { id: 'C1', kind: 'constraint', text: 'no new services' },
  { id: 'R1', kind: 'rejected', text: 'Redis cache', why: 'too much to run' },
  { id: 'Q1', kind: 'question', text: 'Which region?' },
];

describe('ordewell decisions', () => {
  it('says so when nothing is recorded', async () => {
    const { stdout, exitCode } = await decisions([], { tasks: [] });
    expect(exitCode).toBeNull();
    expect(stdout).toContain('Nothing recorded yet.');
  });

  it('prints the standing entries grouped by kind, with ids and whys, and hides the superseded', async () => {
    const { stdout } = await decisions([], { tasks: [], decisionRecord: RECORD });
    expect(stdout).toContain('4 standing · 1 superseded (`ordewell decisions all` shows them)');
    expect(stdout.indexOf('Decisions')).toBeLessThan(stdout.indexOf('Constraints, in your words'));
    expect(stdout).toContain('D2 Use Postgres');
    expect(stdout).toContain('why: we need concurrent writers');
    expect(stdout).toContain('C1 "no new services"');
    expect(stdout).toContain('R1 Redis cache');
    expect(stdout).toContain('Q1 Which region?');
    expect(stdout).not.toContain('Use SQLite');
  });

  it('`all` adds the superseded entries, tagged with what replaced them', async () => {
    const { stdout } = await decisions(['all'], { tasks: [], decisionRecord: RECORD });
    expect(stdout).toContain('1 superseded (shown)');
    expect(stdout).toContain('D1 Use SQLite (superseded by D2)');
    expect(stdout).toContain('why: one file, no server');
  });

  it('refuses an unknown argument with the usage', async () => {
    const { stderr, exitCode } = await decisions(['everything'], { tasks: [] });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage: ordewell decisions [all]');
  });
});
