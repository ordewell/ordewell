import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { unpackedFromAsar } from '../forkDaemon';

describe('unpackedFromAsar', () => {
  it('points a path inside the archive at its unpacked twin', () => {
    expect(unpackedFromAsar('/Applications/Ordewell.app/Contents/Resources/app.asar/node_modules/@ordewell/web/dist/server/main.js'))
      .toBe('/Applications/Ordewell.app/Contents/Resources/app.asar.unpacked/node_modules/@ordewell/web/dist/server/main.js');
  });

  it('handles Windows separators', () => {
    expect(unpackedFromAsar('C:\\Program Files\\Ordewell\\resources\\app.asar\\node_modules\\@ordewell\\web\\dist\\server\\main.js'))
      .toBe('C:\\Program Files\\Ordewell\\resources\\app.asar.unpacked\\node_modules\\@ordewell\\web\\dist\\server\\main.js');
  });

  it('leaves a source checkout path and an already unpacked path alone', () => {
    const checkout = '/work/ordewell/packages/web/dist/server/main.js';
    expect(unpackedFromAsar(checkout)).toBe(checkout);
    const unpacked = '/x/resources/app.asar.unpacked/node_modules/a.js';
    expect(unpackedFromAsar(unpacked)).toBe(unpacked);
  });
});
