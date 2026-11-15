import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import { readJsonFile, writeJsonFile } from './jsonFile';

type MacCommand = (file: string, args: string[], input?: string) => Promise<string>;

const command: MacCommand = (file, args, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(input);
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fingerprint(bundle: string): Promise<string> {
  // The signed resource seal covers app.asar without reading the whole bundle
  // on the first launch or depending on Electron's virtual asar filesystem.
  return createHash('sha256').update(await readFile(join(bundle, 'Contents', '_CodeSignature', 'CodeResources'))).digest('hex');
}

interface Installer {
  image: string;
  mount: string;
}

async function matchingInstaller(bundle: string, build: string, run: MacCommand): Promise<Installer | undefined> {
  const plist = await run('/usr/bin/hdiutil', ['info', '-plist']);
  const info: unknown = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], plist));
  if (!record(info) || !Array.isArray(info.images)) return undefined;
  for (const image of info.images as unknown[]) {
    if (!record(image) || typeof image['image-path'] !== 'string' || !Array.isArray(image['system-entities'])) continue;
    const path = image['image-path'];
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.dmg')) continue;
    for (const entity of image['system-entities'] as unknown[]) {
      if (!record(entity) || typeof entity['mount-point'] !== 'string' || !isAbsolute(entity['mount-point'])) continue;
      const mount = entity['mount-point'];
      try {
        const source = join(mount, basename(bundle));
        if (await realpath(source) === await realpath(bundle)) continue;
        if (await fingerprint(source) !== build || !(await stat(path)).isFile()) continue;
        return { image: await realpath(path), mount };
      } catch { /* An unrelated or disappearing disk image is not this installer's. */ }
    }
  }
  return undefined;
}

interface InstallCompletionOptions {
  bundle: string;
  receipt: string;
  show: (options: MessageBoxOptions) => Promise<number>;
  trash: (path: string) => Promise<void>;
  run?: MacCommand;
}

/** Finder owns the copy; the installed app can confirm it on its first launch. */
export async function completeMacInstall(options: InstallCompletionOptions): Promise<void> {
  const { bundle, receipt, show, trash, run = command } = options;
  const build = await fingerprint(bundle);
  const previous = readJsonFile(receipt);
  const previousBuild = record(previous) && typeof previous.build === 'string' ? previous.build : undefined;
  if (previousBuild === build) return;
  // A payload match also distinguishes development builds sharing a version.
  const installer = await matchingInstaller(bundle, build, run).catch(() => undefined);
  if (!previousBuild || installer) {
    const answer = await show({
      type: 'info',
      message: 'Ordewell is installed',
      detail: installer
        ? `You can start using Ordewell. Would you like to eject the installer and move “${basename(installer.image)}” to Trash?`
        : 'You can start using Ordewell from Applications.',
      buttons: installer ? ['Move Installer to Trash', 'Keep Installer'] : ['Continue'],
      defaultId: installer ? 1 : 0,
      cancelId: installer ? 1 : 0,
      noLink: true,
    });
    writeJsonFile(receipt, { build });
    if (installer && answer === 0) {
      try {
        // The user may have changed mounted images while the dialog was open.
        const current = await matchingInstaller(bundle, build, run);
        if (current?.image !== installer.image || current.mount !== installer.mount) throw new Error('The mounted installer changed.');
        await run('/usr/bin/hdiutil', ['detach', installer.mount]);
        await trash(installer.image);
      } catch {
        await show({
          type: 'info',
          message: 'Ordewell is installed',
          detail: 'The installer could not be removed. You can eject it in Finder and move the DMG to Trash yourself.',
          buttons: ['Continue'],
        });
      }
    }
  } else {
    // Automatic updates have no downloaded DMG for the user to clean up.
    writeJsonFile(receipt, { build });
  }
}
