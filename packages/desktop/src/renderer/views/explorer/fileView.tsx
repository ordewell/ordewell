import type { ReactNode } from 'react';
import { AlertTriangle, Info, Lock } from 'lucide-react';
import { Badge, Icon, Toolbar, type IconComponent } from '@ordewell/ui/design';
import './fileView.css';

/**
 * The pieces a centre tab that shows a file shares: the file tab, the diff
 * tab and the states around Monaco. One place, so the header, the banners and
 * the loading look cannot drift apart between them.
 */

export interface FileHeaderProps {
  /** What the toolbar acts on, for a screen reader. */
  label: string;
  /** `src/a.ts`, repo prefix included when the workspace has several. */
  path: string;
  /** Where the file is read from: a `ScopeBadge`, or the task link when the scope is one. */
  scope: ReactNode;
  /** The unsaved mark, the base and other badges that qualify the file. */
  meta?: ReactNode;
  /** Icon buttons and the like, pushed to the end. */
  actions?: ReactNode;
}

/** The scope a file is read from; a lock says nothing can be saved there. */
export function ScopeBadge({ name, readOnly }: { name: string; readOnly?: boolean }): JSX.Element {
  return <Badge icon={readOnly ? Lock : undefined} title={readOnly ? `${name} (read-only)` : name}>{name}</Badge>;
}

/** A pressed-or-not pair of icon buttons in one box: the layout toggle, where exactly one is on. */
export function Segmented({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return <span role="group" aria-label={label} className="fv-segment">{children}</span>;
}

/** `dir/` and `name` in two boxes, so a narrow bar clips the folders and keeps the file's name. */
function PathLabel({ path }: { path: string }): JSX.Element {
  const cut = path.lastIndexOf('/');
  const dir = cut < 0 ? '' : path.slice(0, cut + 1);
  const name = cut < 0 ? path : path.slice(cut + 1);
  return (
    <span className="fv-path" title={path}>
      {dir && <span className="fv-dir">{dir}</span>}
      <span className="fv-name">{name}</span>
    </span>
  );
}

/**
 * The 36px band above a file or a diff: its path, the scope it is read from, a
 * task link, and the actions. Every item keeps its own box and the row wraps
 * instead of overlapping, because the centre can be as narrow as 560px.
 */
export function FileHeader({ label, path, scope, meta, actions }: FileHeaderProps): JSX.Element {
  return (
    <Toolbar label={label} className="fv-head">
      <PathLabel path={path} />
      <span className="fv-meta">
        {scope}
        {meta}
      </span>
      <span className="ow-toolbar-spacer" />
      {actions && <span className="fv-actions">{actions}</span>}
    </Toolbar>
  );
}

export type BannerTone = 'note' | 'attention';

export interface BannerProps {
  tone?: BannerTone;
  /** `alert` for what the user must act on, `note` for what only informs. */
  role?: 'alert' | 'note' | 'status';
  children: ReactNode;
  /** Buttons, after the words; they wrap under them when the bar is narrow. */
  actions?: ReactNode;
}

/** A line of words above the editor with its actions: read-only, a conflict, a failed save. */
export function Banner({ tone = 'note', role = 'note', children, actions }: BannerProps): JSX.Element {
  const icon: IconComponent = tone === 'attention' ? AlertTriangle : Info;
  return (
    <div className={`fv-banner fv-banner-${tone}`} role={role}>
      <Icon icon={icon} size={16} className="fv-banner-icon" />
      <span className="fv-banner-text">{children}</span>
      {actions && <span className="fv-banner-actions">{actions}</span>}
    </div>
  );
}

/** What stands in for the editor while a file is read: grey lines, so the layout does not jump when it arrives. */
export function EditorSkeleton({ label }: { label: string }): JSX.Element {
  const widths = [38, 64, 52, 0, 71, 46, 58, 33, 0, 62];
  return (
    <div className="fv-skeleton" role="status" aria-label={label}>
      {widths.map((width, index) => (
        <span key={index} className="fv-skeleton-line">
          {width > 0 && <span className="fv-skeleton-bar" style={{ width: `${width}%` }} />}
        </span>
      ))}
    </div>
  );
}
