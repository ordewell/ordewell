import { describe, it, expect, afterEach, vi } from 'vitest';
import { removedPluginNotice } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

vi.mock('@ordewell/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ordewell/core')>();
  return { ...actual, removedPluginNotice: vi.fn() };
});

afterEach(() => vi.restoreAllMocks());

describe('daemon startup with removed runner manifests', () => {
  it('logs one notice per start, regardless of subsequent pool reads', () => {
    const notice = 'Plugin runners were removed; see the CHANGELOG.';
    vi.mocked(removedPluginNotice).mockReturnValue(notice);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pool = new OrchestratorPool();
    pool.getSettings();
    pool.getSettings();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(notice);

    new OrchestratorPool();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not log a removal notice without leftover manifests', () => {
    vi.mocked(removedPluginNotice).mockReturnValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new OrchestratorPool();
    expect(warn).not.toHaveBeenCalled();
  });
});
