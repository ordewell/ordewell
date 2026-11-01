import { createContext, useContext } from 'react';
import { DELEGATION_OFFERED } from '@ordewell/core/plan-utils';

/**
 * Whether delegation is offered (ADR-0055 D21). The switch is read from the
 * checkout a build runs from, which a webview cannot see, so its own constant
 * is false wherever it runs: the host says, with the run settings.
 */
export const DelegationOfferedContext = createContext(false);

export function useDelegationOffered(): boolean {
  const told = useContext(DelegationOfferedContext);
  return DELEGATION_OFFERED || told;
}
