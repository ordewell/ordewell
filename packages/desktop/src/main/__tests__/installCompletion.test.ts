import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeMacInstall } from '../installCompletion';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-install-')));
  roots.push(root);
  const bundle = join(root, 'Applications', 'Ordewell.app');
  const mount = join(root, 'Mounted installer');
  const image = join(root, "Ordewell 'test'.dmg");
  const receipt = join(root, 'user-data', 'install-completion.json');
  const seal = (app: string, value: string) => {
    const path = join(app, 'Contents', '_CodeSignature', 'CodeResources');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  seal(bundle, 'this signed build');
  seal(join(mount, 'Ordewell.app'), 'this signed build');
  writeFileSync(image, 'DMG');
  let images: unknown = [{ 'image-path': image, 'system-entities': [{ 'mount-point': mount }] }];
  const events: string[] = [];
  const show = vi.fn(async () => 1);
  const trash = vi.fn(async (path: string) => { events.push(`trash:${path}`); });
  const run = vi.fn(async (file: string, args: string[], input?: string) => {
    if (file.endsWith('plutil')) {
      expect(input).toBe('plist');
      return JSON.stringify({ images });
    }
    if (args[0] === 'detach') events.push(`detach:${args[1]}`);
    return 'plist';
  });
  return { bundle, receipt, show, trash, run, image, mount, events, seal, images: (value: unknown) => { images = value; } };
}

describe('macOS installation completion', () => {
  it('confirms a successful install, names its matching DMG, and keeps it by default', async () => {
    const f = fixture();
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Ordewell is installed',
      detail: expect.stringContaining("Ordewell 'test'.dmg"),
      buttons: ['Move Installer to Trash', 'Keep Installer'], defaultId: 1, cancelId: 1,
    }));
    expect(f.trash).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledTimes(1);
  });

  it('ejects the matching mounted image before moving only that DMG to Trash, after consent', async () => {
    const f = fixture();
    f.show.mockResolvedValue(0);
    await completeMacInstall(f);
    expect(f.events).toEqual([`detach:${f.mount}`, `trash:${f.image}`]);
    expect(f.trash).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.image, 'utf8')).toBe('DMG');
  });

  it('does not offer cleanup for a different build, even when its app name matches', async () => {
    const f = fixture();
    f.seal(join(f.mount, 'Ordewell.app'), 'another signed build');
    f.show.mockResolvedValue(0);
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Continue'] }));
    expect(f.events).toEqual([]);
  });

  it('confirms the first install without a mounted image, and stays quiet after an automatic update', async () => {
    const f = fixture();
    f.images([]);
    await completeMacInstall(f);
    f.seal(f.bundle, 'updated signed build');
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledTimes(1);
    expect(f.trash).not.toHaveBeenCalled();
  });

  it('confirms a later manual upgrade when its new matching DMG is mounted', async () => {
    const f = fixture();
    await completeMacInstall(f);
    f.seal(f.bundle, 'new signed build');
    f.seal(join(f.mount, 'Ordewell.app'), 'new signed build');
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledTimes(2);
  });

  it('keeps the installer and explains an eject failure without failing installation', async () => {
    const f = fixture();
    f.show.mockResolvedValue(0);
    f.run.mockImplementation(async (file, args) => {
      if (args[0] === 'detach') throw new Error('busy');
      return file.endsWith('plutil') ? JSON.stringify({ images: [{ 'image-path': f.image, 'system-entities': [{ 'mount-point': f.mount }] }] }) : 'plist';
    });
    await completeMacInstall(f);
    expect(f.trash).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringContaining('could not be removed') }));
  });

  it('rechecks the source after consent and refuses cleanup if the mounted payload changed', async () => {
    const f = fixture();
    f.show.mockImplementation(async () => {
      f.seal(join(f.mount, 'Ordewell.app'), 'a replaced image');
      return 0;
    });
    await completeMacInstall(f);
    expect(f.events).toEqual([]);
    expect(f.trash).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenCalledTimes(2);
  });

  it('still confirms installation when disk-image discovery fails', async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error('hdiutil unavailable'));
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Continue'] }));
    expect(f.trash).not.toHaveBeenCalled();
  });

  it('does not mistake the running bundle for the installer source', async () => {
    const f = fixture();
    f.images([{ 'image-path': f.image, 'system-entities': [{ 'mount-point': dirname(f.bundle) }] }]);
    await completeMacInstall(f);
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Continue'] }));
  });

  it.skipIf(process.platform !== 'darwin')('discovers a real mounted DMG through macOS tools, with spaces and quotes in its path', async () => {
    const f = fixture();
    const staging = join(dirname(f.bundle), 'staging');
    f.seal(join(staging, 'Ordewell.app'), 'this signed build');
    const made = spawnSync('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Ordewell test', '-srcfolder', staging, '-format', 'UDZO', '-ov', f.image]);
    expect(made.status, made.stderr.toString()).toBe(0);
    rmSync(f.mount, { recursive: true });
    mkdirSync(f.mount);
    const mounted = spawnSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', f.mount, f.image]);
    expect(mounted.status, mounted.stderr.toString()).toBe(0);
    try {
      await completeMacInstall({ ...f, run: undefined });
      expect(f.show).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Move Installer to Trash', 'Keep Installer'] }));
    } finally {
      spawnSync('/usr/bin/hdiutil', ['detach', '-quiet', f.mount]);
    }
  });

  it.each([null, {}, ['bad'], [{ 'image-path': 'relative.dmg', 'system-entities': [] }]])('ignores malformed mounted-image data: %j', async (images) => {
    const f = fixture();
    f.images(images);
    await completeMacInstall(f);
    expect(f.trash).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Continue'] }));
  });
});
