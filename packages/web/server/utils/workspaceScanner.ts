import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceScannerDeps {
  fsModule: typeof fs;
  pathModule: typeof path;
  cwd: string;
  home: string;
  projectDir: string;
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
  return [...paths].filter(p => p !== pathModule.resolve(projectDir)).sort();
}

export function scanWorkspaces(): string[] {
  return scanWorkspacesImpl({
    fsModule: fs,
    pathModule: path,
    cwd: process.cwd(),
    home: process.env.HOME || '/root',
    projectDir: path.resolve(__dirname, '..', '..', '..', '..'),
  });
}
