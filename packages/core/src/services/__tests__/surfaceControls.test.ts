import { describe, expect, it } from 'vitest';
import { SURFACE_CONTROLS, USER_ACTIONS, UserSurface, clientSurface, surfaceOf, surfaceSettingsBlock } from '../surfaceControls';
import type { LeaseHostKind } from '../../utils/leaseRecord';

describe('surfaceOf', () => {
  it('names a daemon a TUI owns the terminal UI', () => {
    expect(surfaceOf({ kind: 'daemon', port: 3742, ownerPid: 4242 })).toBe('tui');
  });
});

describe('SURFACE_CONTROLS', () => {
  it('has the TUI merge the run with /merge', () => {
    expect(SURFACE_CONTROLS.tui.merge).toContain('/merge');
  });

  it('says how every user-only action is done on every surface', () => {
    for (const surface of Object.keys(SURFACE_CONTROLS) as (keyof typeof SURFACE_CONTROLS)[]) {
      for (const action of USER_ACTIONS) expect(SURFACE_CONTROLS[surface][action], `${surface} ${action}`).toMatch(/\S/);
    }
  });
});

describe('surfaceOf, by the host the lease names', () => {
  it('names the desktop app the daemon it marks', () => {
    expect(surfaceOf({ kind: 'daemon', port: 3742, app: 'desktop' })).toBe('desktop');
  });

  it('names VS Code its own host', () => {
    expect(surfaceOf({ kind: 'vscode' })).toBe('vscode');
  });

  it('cannot tell the surface of a shared daemon, or of no host', () => {
    expect(surfaceOf({ kind: 'daemon', port: 3742 })).toBe('unknown');
    expect(surfaceOf(undefined)).toBe('unknown');
  });
});

describe('surfaceSettingsBlock', () => {
  const settings = { surface: 'tui', automaticMerging: 'off', autorun: false, supervisorLevel: 'watch', parallelLimit: 3 } as const;

  it('opens with its header and states every setting', () => {
    const block = surfaceSettingsBlock(settings);
    expect(block.split('\n')[0]).toBe('SURFACE AND SETTINGS:');
    expect(block).toContain('Autorun: off.');
    expect(block).toContain('Supervisor: Watch.');
    expect(block).toContain('Parallel limit: 3 tasks at once.');
    expect(block).toContain('Compact your conversation: /compact');
  });

  it('has the user merge when automatic merging is off', () => {
    expect(surfaceSettingsBlock(settings)).toContain('Automatic merging: off. Landed work waits for the user\'s merge (/merge).');
  });

  it('never has the user merge when automatic merging is on', () => {
    const block = surfaceSettingsBlock({ ...settings, automaticMerging: 'on' });
    expect(block).toContain('Merges at merge gates and at the end of a run happen by themselves, so never ask the user to merge.');
    expect(block).not.toContain('waits for the user\'s merge');
  });

  it('names no button to a terminal UI user', () => {
    expect(surfaceSettingsBlock(settings)).not.toMatch(/button|card/i);
  });
});

describe('UserSurface: the surface of the user who spoke last', () => {
  const detached: LeaseHostKind = { kind: 'daemon', port: 3742 };

  it('is the surface the sender states, whatever host the daemon is', () => {
    const surface = new UserSurface(() => detached);
    surface.heard('cli');
    expect(surface.current()).toBe('cli');
    surface.heard('tui');
    expect(surface.current()).toBe('tui');
  });

  it('is the host\'s, as before, until a sender states one', () => {
    expect(new UserSurface(() => detached).current()).toBe('unknown');
    expect(new UserSurface(() => ({ kind: 'daemon', port: 3742, ownerPid: 4242 })).current()).toBe('tui');
  });

  it('goes back to the host\'s when a sender states none, as an older client does', () => {
    const surface = new UserSurface(() => detached);
    surface.heard('vscode');
    surface.heard(undefined);
    expect(surface.current()).toBe('unknown');
  });
});

describe('clientSurface', () => {
  it('takes a surface a client may state, and nothing else', () => {
    expect(clientSurface('cli')).toBe('cli');
    expect(clientSurface('desktop')).toBe('desktop');
    expect(clientSurface('unknown')).toBeUndefined();
    expect(clientSurface('emacs')).toBeUndefined();
    expect(clientSurface(3)).toBeUndefined();
  });
});

describe('the CLI\'s controls', () => {
  it('are ordewell commands, `ordewell merge` for the merge', () => {
    expect(SURFACE_CONTROLS.cli.merge).toBe('ordewell merge');
    expect(SURFACE_CONTROLS.cli.skipTask).toBe('ordewell skip <id>');
    expect(SURFACE_CONTROLS.cli.compact).toBe('ordewell compact');
  });

  it('name no button and no slash command as the CLI\'s own', () => {
    const block = surfaceSettingsBlock({ surface: 'cli', automaticMerging: 'off', autorun: false, supervisorLevel: 'watch', parallelLimit: 3 });
    expect(block).toContain('The user is on the ordewell command line');
    expect(block).not.toMatch(/button|card/i);
  });
});
