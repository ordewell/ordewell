import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, filesApi, FilesError, type ReadTarget } from '../../files/api';
import { sortEntries, type DirState } from './treeModel';

export interface TreeController {
  dirs: ReadonlyMap<string, DirState>;
  expanded: ReadonlySet<string>;
  toggle(dir: string): void;
  expand(dir: string): void;
  collapse(dir: string): void;
  reload(): void;
}

/**
 * The lazily read tree of one repo in one scope: a directory is read the first
 * time it opens, and every open one is read again on `reload` (and when the
 * window regains focus in the checkout, where files change under the user).
 * A `gone` scope is reported, never retried (ADR-0061 R2).
 */
export function useTree(target: ReadTarget, scopeId: string, onGone: (message: string) => void): TreeController {
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Reads that were started for an earlier scope must not land in this one.
  const generation = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  const load = useCallback((dir: string): void => {
    const mine = generation.current;
    setDirs((prev) => new Map(prev).set(dir, { ...prev.get(dir), loading: true }));
    filesApi.tree(targetRef.current, dir).then(
      (entries) => {
        if (mine !== generation.current) return;
        setDirs((prev) => new Map(prev).set(dir, { entries: sortEntries(entries), loading: false }));
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        if (error instanceof FilesError && error.code === 'gone') goneRef.current(describeError(error));
        setDirs((prev) => new Map(prev).set(dir, { entries: prev.get(dir)?.entries, loading: false, error: describeError(error) }));
      },
    );
  }, []);

  // Directories asked for in this scope, so opening one twice reads it once.
  const requested = useRef(new Set<string>());

  useEffect(() => {
    generation.current += 1;
    requested.current = new Set(['']);
    setDirs(new Map());
    setExpanded(new Set());
    load('');
  }, [scopeId, load]);

  const open = useCallback((dir: string): void => {
    setExpanded((prev) => new Set(prev).add(dir));
    if (requested.current.has(dir)) return;
    requested.current.add(dir);
    load(dir);
  }, [load]);

  const reload = useCallback((): void => {
    for (const dir of requested.current) load(dir);
  }, [load]);

  useEffect(() => {
    if (target.scope.kind !== 'checkout') return;
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [target.scope.kind, reload]);

  return {
    dirs,
    expanded,
    toggle: (dir) => (expanded.has(dir) ? setExpanded((prev) => { const next = new Set(prev); next.delete(dir); return next; }) : open(dir)),
    expand: open,
    collapse: (dir) => setExpanded((prev) => { const next = new Set(prev); next.delete(dir); return next; }),
    reload,
  };
}
