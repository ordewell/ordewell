import { DELEGATION_OFFERED, type GlobalRunSettings } from '@ordewell/core';
import { runSettingRiskConfirmations } from '@ordewell/ui/host';
import { confirm } from '../plan/confirm';

/**
 * What turning Act, autorun or Subplanners on asks first, whether from the
 * Settings panel or the extension host (ADR-0030). `delegationTokens` is the
 * budget now: a change to one already on accepts nothing new.
 */
export async function confirmRisks(changes: Partial<GlobalRunSettings>, delegationTokens: number): Promise<boolean> {
  for (const request of runSettingRiskConfirmations(changes, delegationTokens, DELEGATION_OFFERED)) {
    if (!(await confirm(request))) return false;
  }
  return true;
}
