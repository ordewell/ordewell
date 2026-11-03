import { describe, it, expect } from 'vitest';
import { manualOverrideConfirmation, pastGateConfirmation } from '@ordewell/core/plan-utils';
import {
  discardRunConfirmation, forkStopsRunConfirmation, mergeAllConfirmation, mergePastChecksQuestion, overrideConfirmation,
  runSettingRiskConfirmations, startPastGateConfirmation,
} from '../confirmations';

describe('confirmations as data', () => {
  it('asks each risky run setting once, in order, and Subplanners only where the host offers them', () => {
    const changes = { supervisorLevel: 'act' as const, autorun: true, delegationTokens: 50_000 };
    expect(runSettingRiskConfirmations(changes, 0, true).map((c) => c.message)).toEqual([
      'Let the supervisor act?', 'Start plans without review?', 'Turn Subplanners on?',
    ]);
    expect(runSettingRiskConfirmations(changes, 0, false).map((c) => c.message)).toEqual(['Let the supervisor act?', 'Start plans without review?']);
    // A budget already on asks nothing new.
    expect(runSettingRiskConfirmations({ delegationTokens: 90_000 }, 50_000, true)).toEqual([]);
    expect(runSettingRiskConfirmations({ autorun: false }, 0, true)).toEqual([]);
  });

  it('keeps core\'s wording and gives each yes the button it always had', () => {
    expect(startPastGateConfirmation(['#2 Build'])).toEqual({
      kind: 'start_past_gate', message: pastGateConfirmation(['#2 Build']), choices: [{ id: 'start', label: 'Start anyway' }],
    });
    expect(overrideConfirmation('complete', 'Mark complete').choices).toEqual([{ id: 'override', label: 'Mark complete' }]);
    expect(overrideConfirmation('complete', 'x').message).toBe(manualOverrideConfirmation('complete', 'x'));
    expect(mergeAllConfirmation('main', '', true).message).toMatch(/^Merge what the run has landed so far into main\. .*The run goes on/);
    expect(mergeAllConfirmation('main', '', false).message).toMatch(/^Merge the isolated run into main\./);
    expect(mergePastChecksQuestion('No check passed on #3.', 'main')).toMatchObject({ message: 'No check passed on #3. Merge main anyway?', choices: [{ label: 'Merge anyway' }] });
    expect(discardRunConfirmation().choices).toEqual([{ id: 'discard', label: 'Discard' }]);
    expect(forkStopsRunConfirmation().choices).toEqual([{ id: 'fork', label: 'Fork and stop the run' }]);
  });
});
