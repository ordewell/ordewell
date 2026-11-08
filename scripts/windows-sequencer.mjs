// The scope runner packs all workspaces together; Vitest still owns discovery
// and execution in each workspace. A file carries the list off the command line
// to stay below Windows' command and environment length limits.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer } from 'vitest/node';

export default class WindowsSequencer extends BaseSequencer {
  files() {
    return JSON.parse(readFileSync(process.env.ORDEWELL_WINDOWS_FILES, 'utf8')).map((file) => path.resolve(file));
  }

  sort(specs) {
    const ranks = new Map(this.files().map((file, index) => [file, index]));
    return [...specs].sort((a, b) => ranks.get(path.resolve(a.moduleId)) - ranks.get(path.resolve(b.moduleId)));
  }

  shard(specs) {
    const files = new Set(this.files());
    const selected = specs.filter(({ moduleId }) => files.has(path.resolve(moduleId)));
    if (selected.length !== files.size) throw new Error('Windows assignment differs from Vitest discovery');
    return selected;
  }
}
