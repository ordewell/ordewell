import * as fs from 'fs';
import * as path from 'path';
import { globalDataDir } from '../utils/globalDataDir';

function isManifestFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function removedPluginNotice(dataDir: string = globalDataDir()): string | undefined {
  const directory = path.join(dataDir, 'plugins');
  try {
    const hasManifest = isManifestFile(path.join(directory, 'manifest.json'))
      || fs.readdirSync(directory, { withFileTypes: true }).some((entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) && isManifestFile(path.join(directory, entry.name, 'manifest.json')),
      );
    if (hasManifest) return 'Plugin runners were removed; manifests in ~/.ordewell/plugins/ are ignored. See the CHANGELOG.';
  } catch {
    return undefined;
  }
  return undefined;
}
