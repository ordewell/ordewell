/**
 * The design kit: icons, Ordewell's glyphs, the status vocabulary and the
 * shared controls. Its own entry, so a host that draws only the chat never
 * bundles Lucide; its looks are in design.css, its sizes in scale.css.
 */
export { Icon, IconButton, type IconComponent, type IconProps, type IconButtonProps } from './design/Icon';
export {
  ICON_STROKE, ICON_STROKE_SMALL, strokeFor, GLYPHS,
  PlanGlyph, LoopGlyph, CheckpointGlyph, RunnerGlyph, MergeAllGlyph, NeedsYouGlyph, ChildPlanGlyph, ViewScopeGlyph,
  type GlyphProps, type IconSize,
} from './design/glyphs';
export { PullIcon, PushIcon } from './design/arrows';
export {
  STATUSES, statusOf, statusLineOf, StatusIndicator,
  type StatusId, type StatusTone, type StatusLook, type StatusIndicatorProps,
} from './design/status';
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize, type ButtonBusyMotion } from './design/Button';
export { Badge, type BadgeProps, type BadgeTone } from './design/Badge';
export { RUNNER_NAMES, runnerName, RunnerBadge, type RunnerBadgeProps } from './design/runners';
export { DEFAULT_MODEL_LABEL, modelLabel, modelShortLabel, effortLabel } from './design/assignment';
export {
  SectionHeader, Card, EmptyState, Toolbar, Kbd,
  type SectionHeaderProps, type CardProps, type EmptyStateProps, type ToolbarProps,
} from './design/layout';
export { Tabs, type TabsProps, type TabItem } from './design/Tabs';
