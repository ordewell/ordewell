import * as vscode from 'vscode';
import { ACT_RISK, AUTORUN_RISK, DELEGATION_RISK, type GlobalRunSettings } from '@ordewell/core';

async function confirmed(title: string, detail: string, confirm: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(title, { modal: true, detail }, confirm)) === confirm;
}

/**
 * What turning Act, autorun or delegation on asks first, whether from the
 * Settings panel or the extension host (ADR-0030). `delegationTokens` is the
 * budget now: a change to one already on accepts nothing new.
 */
export async function confirmRisks(changes: Partial<GlobalRunSettings>, delegationTokens: number): Promise<boolean> {
  if (changes.supervisorLevel === 'act' && !(await confirmed('Let the supervisor act?', `At Act the supervisor runs, stops and retries tasks, edits the plan and merges, without asking you. ${ACT_RISK}`, 'Let it act'))) return false;
  if (changes.autorun === true && !(await confirmed('Start plans without review?', `Each plan the planner submits starts at once, as if you had pressed Execute. ${AUTORUN_RISK}`, 'Turn autorun on'))) return false;
  if (delegationTokens === 0 && (changes.delegationTokens ?? 0) > 0 && !(await confirmed('Let plans delegate?', `A tree of plans may spend up to ${changes.delegationTokens} tokens. ${DELEGATION_RISK}`, 'Turn delegation on'))) return false;
  return true;
}
