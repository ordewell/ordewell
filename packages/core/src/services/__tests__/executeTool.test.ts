import { describe, it, expect, vi } from 'vitest';
import { executeTool } from '../executeTool';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';

function fakeFs(overrides?: Partial<IFileSystem>): IFileSystem {
  return {
    readFile: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    readFiles: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    glob: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    grep: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    findSymbol: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    listDir: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    bash: vi.fn().mockResolvedValue({ success: false, output: '', truncated: false }),
    getWorkspaceRoot: vi.fn().mockReturnValue('/'),
    ...overrides,
  };
}

function fakeFetcher(overrides?: Partial<IWebFetcher>): IWebFetcher {
  return {
    confirm: vi.fn().mockResolvedValue(true),
    fetch: vi.fn().mockResolvedValue({ success: true, output: '<h1>Docs</h1>', truncated: false }),
    ...overrides,
  };
}

describe('executeTool', () => {
  describe('fetch', () => {
    it('returns an error when no fetcher is provided', async () => {
      const result = await executeTool('fetch', { url: 'https://example.com' }, fakeFs());

      expect(result.success).toBe(false);
      expect(result.output).toContain('not available');
    });

    it('returns an error when user denies the URL', async () => {
      const fetcher = fakeFetcher({ confirm: vi.fn().mockResolvedValue(false) });
      const result = await executeTool('fetch', { url: 'https://example.com' }, fakeFs(), fetcher);

      expect(fetcher.confirm).toHaveBeenCalledWith('https://example.com');
      expect(fetcher.fetch).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.output).toContain('denied');
    });

    it('calls fetcher.fetch when user approves the URL', async () => {
      const fetcher = fakeFetcher();
      const result = await executeTool('fetch', { url: 'https://docs.rs' }, fakeFs(), fetcher);

      expect(fetcher.confirm).toHaveBeenCalledWith('https://docs.rs');
      expect(fetcher.fetch).toHaveBeenCalledWith('https://docs.rs');
      expect(result.success).toBe(true);
    });
  });

  describe('web_search', () => {
    it('degrades with a usable alternative when the fetcher cannot search', async () => {
      const result = await executeTool('web_search', { query: 'hono routing' }, fakeFs(), fakeFetcher());

      expect(result.success).toBe(false);
      expect(result.output).toContain('not available');
      expect(result.output).toContain('fetch tool');
    });

    it('delegates to the fetcher when search is wired', async () => {
      const search = vi.fn().mockResolvedValue({ success: true, output: '1. Hono docs', truncated: false });
      const result = await executeTool('web_search', { query: 'hono routing' }, fakeFs(), fakeFetcher({ search }));

      expect(search).toHaveBeenCalledWith('hono routing');
      expect(result.success).toBe(true);
    });

    it('rejects an empty query rather than searching for nothing', async () => {
      const search = vi.fn();
      const result = await executeTool('web_search', { query: '  ' }, fakeFs(), fakeFetcher({ search }));

      expect(result.success).toBe(false);
      expect(search).not.toHaveBeenCalled();
    });
  });

  describe('grep argument mapping', () => {
    it('maps the snake_case names the model emits onto GrepOptions', async () => {
      const grep = vi.fn().mockResolvedValue({ success: true, output: '', truncated: false });
      await executeTool('grep', {
        pattern: 'TODO',
        include: '*.ts',
        path: 'src',
        output_mode: 'files',
        context_before: 2,
        context_after: 3,
        literal: true,
        case_insensitive: true,
        head_limit: 25,
      }, fakeFs({ grep }));

      expect(grep).toHaveBeenCalledWith('TODO', expect.objectContaining({
        include: '*.ts',
        path: 'src',
        outputMode: 'files',
        contextBefore: 2,
        contextAfter: 3,
        literal: true,
        caseInsensitive: true,
        headLimit: 25,
      }));
    });

    it('drops an output_mode the model invented instead of passing it through', async () => {
      const grep = vi.fn().mockResolvedValue({ success: true, output: '', truncated: false });
      await executeTool('grep', { pattern: 'TODO', output_mode: 'sideways' }, fakeFs({ grep }));

      expect(grep).toHaveBeenCalledWith('TODO', expect.objectContaining({ outputMode: undefined }));
    });

    it('ignores a non-numeric head_limit rather than forwarding NaN', async () => {
      const grep = vi.fn().mockResolvedValue({ success: true, output: '', truncated: false });
      await executeTool('grep', { pattern: 'TODO', head_limit: 'lots' }, fakeFs({ grep }));

      expect(grep).toHaveBeenCalledWith('TODO', expect.objectContaining({ headLimit: undefined }));
    });
  });

  describe('find_symbol', () => {
    it('forwards the symbol with its optional language and path', async () => {
      const findSymbol = vi.fn().mockResolvedValue({ success: true, output: '', truncated: false });
      await executeTool('find_symbol', { symbol: 'VerdictEngine', language: 'typescript', path: 'src' }, fakeFs({ findSymbol }));

      expect(findSymbol).toHaveBeenCalledWith('VerdictEngine', { language: 'typescript', path: 'src' });
    });
  });

  describe('unknown tools', () => {
    it('steers a hallucinated write tool back to planning, and lists the real toolset', async () => {
      const result = await executeTool('write_file', { path: 'a.ts' }, fakeFs());

      expect(result.success).toBe(false);
      expect(result.output).toContain('You are a PLANNER');
      expect(result.output).toContain('find_symbol');
      expect(result.output).toContain('web_search');
    });
  });
});
