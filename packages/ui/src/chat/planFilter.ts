import { createContext, useContext } from 'react';

/**
 * A plan-panel status filter is active: the desktop's rail opened the plan on
 * one status, so the frame reveals a collapsed row's folded descendants with
 * CSS alone. That leaves the row showing content while its editor body stays
 * closed. React needs the same fact to keep the row heading's `aria-expanded`
 * honest — a screen reader must not hear "collapsed" while those descendants
 * are on screen. Every other surface (the planner conversation, VS Code cards,
 * hosts that never filter) keeps the default, where the heading describes its
 * body alone.
 */
export const PlanFilterActiveContext = createContext(false);

export function usePlanFilterActive(): boolean {
  return useContext(PlanFilterActiveContext);
}
