import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_AUTONOMOUS_MODE, DEFAULT_MAX_PARALLEL, DEFAULT_SUPERVISOR_RETRY_LIMIT, DEFAULT_WAKE_UP_READ_BUDGET, RUN_SETTINGS_DEFAULTS } from '../../plan-utils';
import { RUN_SETTINGS_DEFAULTS as SERVICE_DEFAULTS, SettingsService } from '../SettingsService';
import { DEFAULT_MAX_PARALLEL as UTIL_MAX_PARALLEL } from '../../utils/maxParallel';

// A surface that restores defaults (the desktop's Settings) reads them from the
// browser-safe entry, so they must be the very values the service falls back to.
describe('the run settings defaults a browser can read', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('are the service\'s own defaults, not a copy', () => {
    expect(RUN_SETTINGS_DEFAULTS).toBe(SERVICE_DEFAULTS);
    expect(RUN_SETTINGS_DEFAULTS.supervisorRetryLimit).toBe(DEFAULT_SUPERVISOR_RETRY_LIMIT);
    expect(RUN_SETTINGS_DEFAULTS.wakeUpReadBudget).toBe(DEFAULT_WAKE_UP_READ_BUDGET);
    expect(DEFAULT_MAX_PARALLEL).toBe(UTIL_MAX_PARALLEL);
  });

  it('name the autonomy a fresh install starts with', () => {
    expect(DEFAULT_AUTONOMOUS_MODE).toBe(false);
    vi.stubEnv('ORDEWELL_AUTONOMOUS_MODE', '');
    expect(new SettingsService(path.join(os.tmpdir(), `ordewell-no-such-settings-${process.pid}.json`)).autonomousMode()).toBe(DEFAULT_AUTONOMOUS_MODE);
  });
});
