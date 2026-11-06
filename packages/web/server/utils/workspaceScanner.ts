import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSea, type SeaDeps } from '@ordewell/core';

export interface WorkspaceScannerDeps {
  fsModule: typeof fs;
  pathModule: typeof path;
  cwd: string;
  home: string;
  /** A folder never to list; undefined lists every one found. */
  projectDir: string | undefined;
}

export function scanWorkspacesImpl(deps: WorkspaceScannerDeps): string[] {
  const { fsModule, pathModule, cwd, home, projectDir } = deps;
  const paths = new Set<string>();
  const searchRoots = [
    cwd,
    home,
    pathModule.join(home, 'projects'),
    pathModule.join(home, 'dev'),
    pathModule.join(home, 'code'),
    pathModule.join(home, 'src'),
    pathModule.join(home, 'Desktop'),
    pathModule.join(home, 'Documents'),
  ];
  for (const root of searchRoots) {
    try {
      if (fsModule.existsSync(pathModule.join(root, '.ordewell'))) paths.add(root);
      const entries = fsModule.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory());
      for (const e of entries.slice(0, 50)) {
        const sub = pathModule.join(root, e.name);
        if (fsModule.existsSync(pathModule.join(sub, '.ordewell'))) paths.add(sub);
      }
    } catch { /* empty */ }
  }
  const hidden = projectDir === undefined ? undefined : pathModule.resolve(projectDir);
  return [...paths].filter(p => p !== hidden).sort();
}

export function scanWorkspaces(sea: SeaDeps = {}): string[] {
  return scanWorkspacesImpl({
    fsModule: fs,
    pathModule: path,
    cwd: process.cwd(),
    // Not HOME, which Windows does not set: os.homedir() reads USERPROFILE there.
    home: os.homedir(),
    // Four up from dist/server/ is the root of an Ordewell source checkout,
    // whose own `.ordewell/` (its committed skills) is no workspace of the
    // user's. The binary has no checkout: its `__dirname` is the executable's
    // folder, and four up from there could be the home or a projects folder
    // that does hold one, so nothing is hidden (ADR-0065 C2).
    projectDir: isSea(sea) ? undefined : path.resolve(__dirname, '..', '..', '..', '..'),
  });
}
