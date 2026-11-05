import { JsonRpcPeer } from './jsonRpc';

export type { RpcMessage, RpcResponse, RpcHandler } from './jsonRpc';

/**
 * Codex's `app-server` connection: a {@link JsonRpcPeer} whose requests are
 * all the adapter's own to answer — approvals and the like arrive as requests
 * the adapter routes by method, so nothing is answered -32601 on its behalf
 * and `dispatch` leaves every request and notification to the caller.
 *
 * The thread request follows `initialize` as id 2 unless a question comes
 * between: a read-only task's `config/read`, or a Windows change task's
 * sandbox readiness.
 */
export class CodexRpc extends JsonRpcPeer {
  protected override unroutedRequest(): boolean {
    return false;
  }
}
