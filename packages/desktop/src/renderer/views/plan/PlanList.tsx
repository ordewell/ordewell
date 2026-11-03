import type { DaemonHost } from '../../session/DaemonHost';
import { ChatSurface } from '../../session/useSession';

/**
 * The plan as a list (W3): the chat's own cards, drawn without its
 * conversation, so every row action is the one the extension offers and
 * answers the same way.
 */
export function PlanList({ host }: { host: DaemonHost }): JSX.Element {
  return <ChatSurface host={host} layout="plan" />;
}
