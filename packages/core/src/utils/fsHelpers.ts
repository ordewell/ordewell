import * as fs from 'fs';
import * as path from 'path';

export const STATE_DIR = '.ordewell';

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getStateDir(baseDir?: string): string {
  return path.join(baseDir ?? process.cwd(), STATE_DIR);
}
