import { createContext, useContext } from 'react';

/** Opens a workspace-relative file a handoff saved, the patch beside the task log (ADR-0050), in an editor tab. */
export type OpenPatch = (path: string) => void;

/**
 * The surface's way to open a saved patch. It is null where the surface has
 * none, so the handoff block draws no control it cannot honour.
 */
export const OpenPatchContext = createContext<OpenPatch | null>(null);

export function useOpenPatch(): OpenPatch | null {
  return useContext(OpenPatchContext);
}
