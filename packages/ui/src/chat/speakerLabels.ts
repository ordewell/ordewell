import { createContext } from 'react';

/**
 * Whether each message names its speaker (docs/desktop/design.md, W2). A tab
 * as wide as the desktop's planner tab reads a conversation down one centred
 * column, where side and colour alone no longer tell who spoke; VS Code's
 * narrow sidebar keeps its bubbles unlabelled.
 */
export const SpeakerLabelsContext = createContext(false);
