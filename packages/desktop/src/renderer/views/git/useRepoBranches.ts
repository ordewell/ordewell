import { useEffect, useState } from 'react';
import type { FrameApi } from '../../frame/api';
import { readBranches, type Branches } from './gitData';

/**
 * The branches of one repository for a surface that is not the Git sidebar
 * (the checkout's sync line and its stash menu). Read again when `key`
 * changes, which the caller derives from what a sync or a switch moves: the
 * branch, its upstream and the commit it is on.
 */
export function useRepoBranches(api: FrameApi, repo: string, key: string): Branches | undefined {
  const [branches, setBranches] = useState<Branches>();
  useEffect(() => {
    let live = true;
    readBranches(api.workspace, repo).then((read) => { if (live) setBranches(read); }, () => { if (live) setBranches(undefined); });
    return () => { live = false; };
  }, [api, repo, key]);
  return branches;
}
