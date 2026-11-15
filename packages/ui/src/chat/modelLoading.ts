import { createContext } from 'react';
import type { HostState } from './hostState';

/** Every planner, task and subtask picker reads the same catalog's progress. */
export const ModelDiscoveryContext = createContext<HostState['modelDiscovery']>(null);
