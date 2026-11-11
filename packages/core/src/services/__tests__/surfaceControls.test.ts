import { describe, expect, it } from 'vitest';
import { SURFACE_CONTROLS, USER_ACTIONS, surfaceOf, surfaceSettingsBlock } from '../surfaceControls';

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
