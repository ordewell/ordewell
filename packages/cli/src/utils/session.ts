import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LAST_SESSION_FILE = join(homedir(), '.config', 'ordewell', 'last-session.json');

export function saveLastSession(sessionId: string, goal: string, runners: string[], workspace: string): void {
  const dir = join(homedir(), '.config', 'ordewell');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    LAST_SESSION_FILE,
    JSON.stringify({ sessionId, goal, runners, workspace, createdAt: new Date().toISOString() }, null, 2),
  );
}

export function readLastSession(): { sessionId: string; goal: string; runners: string[]; workspace: string } | null {
  try {
    if (existsSync(LAST_SESSION_FILE)) {
      return JSON.parse(readFileSync(LAST_SESSION_FILE, 'utf8'));
    }
  } catch { /* empty */ }
  return null;
}
