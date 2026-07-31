import { describe, it, expect, vi } from 'vitest';
import { ContextCollector } from '../ContextCollector';
import type { IFileSystem } from '../../interfaces/IFileSystem';

function fakeFs(overrides?: Partial<IFileSystem>): IFileSystem {
  return {
    readFile: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    readFiles: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    glob: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    grep: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    findSymbol: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    listDir: vi.fn().mockResolvedValue({ success: true, output: 'file list', truncated: false }),
    bash: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    getWorkspaceRoot: vi.fn().mockReturnValue('/'),
    ...overrides,
  };
}

describe('ContextCollector', () => {
  describe('collect', () => {
    it('calls listDir with depth 3 for a tree view', async () => {
      const fs = fakeFs();
      const collector = new ContextCollector(fs);

      await collector.collect('opencode');

      expect(fs.listDir).toHaveBeenCalledWith('.', 3);
    });
  });
});
