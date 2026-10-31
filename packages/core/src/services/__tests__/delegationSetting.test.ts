import { describe, expect, it } from 'vitest';
import { DELEGATION_RISK, delegationSummary, parseDelegation } from '../runSettingsText';
import { RUN_SETTINGS_DEFAULTS, RunSettingsError, SettingsService, runSettingsOf } from '../SettingsService';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeSession, testWorkspace } from './sessionTestKit';
import { task } from './supervisorTestKit';

/**
 * Delegation is a run setting, off by default, and turning it on sets the
 * tree's token budget (ADR-0055 D21). Nothing can delegate yet, so all it moves
 * is the root's mandate.
 */

describe('the delegation setting (ADR-0055 D21)', () => {
  it('is off by default', () => {
    expect(RUN_SETTINGS_DEFAULTS.delegationTokens).toBe(0);
    expect(runSettingsOf({}).delegationTokens).toBe(0);
  });

  it('saves a budget, reads it back, and takes 0 for off', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-delegation-')), 'settings.json');
    const service = new SettingsService(file);

    expect(service.updateRunSettings({ delegationTokens: 5_000_000 }).delegationTokens).toBe(5_000_000);
    expect(new SettingsService(file).getRunSettings().delegationTokens).toBe(5_000_000);
    expect(service.updateRunSettings({ delegationTokens: 0 }).delegationTokens).toBe(0);
  });

  it.each([-1, 1.5])('refuses %s and saves nothing', (delegationTokens) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-delegation-')), 'settings.json');
    const service = new SettingsService(file);

    expect(() => service.updateRunSettings({ delegationTokens })).toThrow(RunSettingsError);
    expect(service.getRunSettings().delegationTokens).toBe(0);
  });

  it('leaves a hand-edited value it cannot use at its default', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-delegation-')), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ delegationTokens: 'lots' }));

    expect(new SettingsService(file).getRunSettings().delegationTokens).toBe(0);
  });

  it('is read as typed: `off`, or a positive whole number', () => {
    expect(parseDelegation('off')).toBe(0);
    expect(parseDelegation('5000000')).toBe(5_000_000);
    expect(parseDelegation('0')).toBeNull();
    expect(parseDelegation('on')).toBeNull();
    expect(parseDelegation('1.5')).toBeNull();
  });

  it('is summarised on or off', () => {
    expect(delegationSummary({ ...RUN_SETTINGS_DEFAULTS })).toBe('Delegation: off');
    expect(delegationSummary({ ...RUN_SETTINGS_DEFAULTS, delegationTokens: 1000 })).toBe('Delegation: on, 1000 tokens for a tree');
  });

  it('says what M9 says its confirmation must: no person reads the plan, and it runs with the network', () => {
    expect(DELEGATION_RISK).toMatch(/no person reads it/);
    expect(DELEGATION_RISK).toMatch(/keep the network they have in a flat run/);
    expect(DELEGATION_RISK).toMatch(/instruction injected/);
  });
});

describe('the root\'s mandate reads it where it lives (ADR-0030, ADR-0056 M1)', () => {
  const plan = () => ({ tasks: [task('t1', 1)], generatedAt: '2026-10-11T00:00:00Z', lastUpdated: '2026-10-11T00:00:00Z', status: 'approved' as const, runners: ['claude-code'] });

  it('takes a change at once, in the session it is made in, and leaves the plan out of it', () => {
    const session = makeSession();
    session.loadPlan(plan(), 'goal', testWorkspace, { persist: false });
    expect(session.mandate().grants.has('delegate')).toBe(false);
    expect(session.mandate().limits.tokens).toBe(0);

    session.applyRunSettings({ delegationTokens: 1000 });

    expect(session.mandate().grants.has('delegate')).toBe(true);
    expect(session.mandate().limits.tokens).toBe(1000);
    expect(session.planState!.runSettings).toBeUndefined();

    session.applyRunSettings({ delegationTokens: 0 });
    expect(session.mandate().grantable.size).toBe(0);
    session.destroy();
  });

  it('starts from the file, as a new session does', () => {
    const session = makeSession({ settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 1000 } }) });
    expect(session.mandate().limits.tokens).toBe(1000);
    session.destroy();
  });

  it('keeps it out of what is saved with the plan', () => {
    const session = makeSession();
    session.loadPlan(plan(), 'goal', testWorkspace, { persist: false });
    session.applyRunSettings({ delegationTokens: 1000 });
    expect(JSON.stringify(session.planState)).not.toContain('delegationTokens');
    session.destroy();
  });
});
