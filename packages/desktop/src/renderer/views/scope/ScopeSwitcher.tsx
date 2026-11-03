import { ViewScopeGlyph, Icon } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { all } from '../Stub';

/**
 * The view scope picker in the title bar, and the repo and branch the
 * breadcrumb shows after the workspace (ADR-0061 R2). Design slice 11 owns
 * this file.
 */
function ScopeSwitcher(): JSX.Element {
  return (
    <span className="frame-chip" title="View scope: the checkout">
      <Icon icon={ViewScopeGlyph} size={16} />
      Checkout
    </span>
  );
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerSlot({ slot: 'title.scope', id: 'scope', render: () => <ScopeSwitcher /> }),
    api.registerSlot({ slot: 'title.breadcrumb', id: 'repo-branch', render: () => null }),
  );
}
