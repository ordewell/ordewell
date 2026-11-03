/**
 * The design kit: icons, Ordewell's glyphs and the status vocabulary. Its own
 * entry, so a host that draws only the chat never bundles Lucide; its looks
 * are in design.css, its sizes in scale.css.
 */
export { Icon, IconButton, type IconComponent, type IconProps, type IconButtonProps } from './design/Icon';
export {
  ICON_STROKE, GLYPHS,
  PlanGlyph, LoopGlyph, CheckpointGlyph, RunnerGlyph, MergeAllGlyph, NeedsYouGlyph, ChildPlanGlyph, ViewScopeGlyph,
  type GlyphProps, type IconSize,
} from './design/glyphs';
export {
  STATUSES, statusOf, StatusIndicator,
  type StatusId, type StatusTone, type StatusLook, type StatusIndicatorProps,
} from './design/status';
