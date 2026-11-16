import { privateTempDir, type PrivateTempDir } from '../../utils/privateTempDir';

/** A directory an ACP process is handed its files in: owner-only, outside any repository. */
export type AcpPrivateDir = PrivateTempDir;

/**
 * A new private directory in the temp directory, `ordewell-acp-<pid>-XXXXXX`.
 * What it holds can carry an attempt's token (ADR-0060, R4), so the leftovers
 * of an Ordewell that died before removing its own are swept first.
 */
export function acpPrivateDir(): AcpPrivateDir {
  return privateTempDir('acp');
}
