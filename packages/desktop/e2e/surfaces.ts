/**
 * The tour's lift check (docs/desktop/design.md, Surfaces): a card is seen by
 * its fill, so each one must stand off what is drawn behind it, and its text
 * must still read on that fill. The contrast unit test checks the token values;
 * this checks the cards as the app paints them, where a rule can put a card on
 * a surface the tokens never paired it with.
 */

/**
 * What the ladder draws as a card or as an inset inside one. List rows are not
 * cards: a collapsed plan row is flat until it opens. Extend this list when a
 * surface starts drawing a card.
 */
export const CARD_SELECTORS: readonly string[] = [
  '.task-card:not(.task-row-card)',
  '.task-card.task-row-card.expanded',
  '.plan-approval-card',
  '.approval-card',
  '.isolation-handoff',
  'section.isolation-notice',
  '.subagent-card',
  '.task-add-form',
  '.ow-card',
  '.welcome-card:not(.welcome-empty)',
  '.welcome-banner',
  '.graph-card',
  '.needs-item',
  '.settings-section',
  '.settings-error',
  '.frame-banner',
  '.changes-group-head',
  '.changes-preflight-repo',
  '.snotice',
  // Insets: they step back from the card they sit in, so they lift off it the other way.
  '.task-output',
  '.task-isolation',
  '.task-prompt-readonly',
  '.task-script-body',
  '.approval-card-body',
  '.subtask-card',
  '.changes-comment-input',
  '.welcome-code',
  '.settings-runner',
];

/** The least a fill may differ from its backdrop, as a WCAG contrast ratio. */
export const LIFT_MIN = 1.05;
export const TEXT_MIN = 4.5;

export interface LiftResult {
  /** Each card that does not lift, and each text on a card that does not read. */
  readonly problems: string[];
  /** Each distinct fill measured, with its backdrop and ratio, for the report. */
  readonly measured: string[];
}

/**
 * Runs in the renderer, so it uses nothing from this module: the selectors and
 * thresholds come in as its argument. A fill is composited over every
 * translucent ancestor down to the first opaque one, as the screen shows it.
 */
export function liftChecks(input: { selectors: readonly string[]; liftMin: number; textMin: number }): LiftResult {
  type Rgba = [number, number, number, number];
  const parse = (value: string): Rgba | undefined => {
    const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    // A color-mix() computes to color(srgb …) in Chromium, channels from 0 to 1.
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(value);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    return undefined;
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const luminance = ([r, g, b]: Rgba): number => {
    const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const ratio = (a: Rgba, b: Rgba): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c: Rgba): string => `#${c.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
  const unparsed = new Set<string>();
  const fillOf = (el: Element): Rgba => {
    const value = getComputedStyle(el).backgroundColor;
    const parsed = parse(value);
    if (!parsed) unparsed.add(value);
    return parsed ?? [0, 0, 0, 0];
  };
  /** What the screen shows behind `el`'s own fill: its ancestors' fills, composited down to the first opaque one. */
  const backdrop = (el: Element | null): Rgba => {
    const layers: Rgba[] = [];
    for (let at = el; at; at = at.parentElement) {
      const fill = fillOf(at);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] >= 1) break;
    }
    // A window paints white under a page that paints nothing.
    return layers.reverse().reduce<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
  };
  const name = (el: Element): string => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  };

  const problems: string[] = [];
  const measured = new Set<string>();
  const seen = new Set<Element>();
  for (const selector of input.selectors) {
    for (const card of document.querySelectorAll(selector)) {
      if (seen.has(card) || !shown(card)) continue;
      seen.add(card);
      const behind = backdrop(card.parentElement);
      const fill = over(fillOf(card), behind);
      const lift = ratio(fill, behind);
      measured.add(`${selector}: ${hex(fill)} on ${hex(behind)} = ${lift.toFixed(3)}`);
      if (lift < input.liftMin) problems.push(`${selector} (${name(card)}) is ${hex(fill)} on ${hex(behind)}: ${lift.toFixed(3)} < ${input.liftMin}`);

      // Text the card's own fill shows through: each element holding text, on what is painted under it.
      // Text on a fill of its own inside the card (a status chip, an inset) is
      // not on the ladder: a status tint keeps its value, and an inset has its own pass.
      const onCard = (el: Element): boolean => {
        for (let at: Element | null = el; at && at !== card; at = at.parentElement) if (fillOf(at)[3] > 0) return false;
        return true;
      };
      for (const el of [card, ...card.querySelectorAll('*')]) {
        const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!own || !shown(el) || !onCard(el) || el.closest('[disabled], [aria-disabled="true"], .sr-only')) continue;
        const style = getComputedStyle(el);
        const color = parse(style.color);
        if (!color) { unparsed.add(style.color); continue; }
        const under = backdrop(el);
        const text = over(color, under);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        const min = large ? 3 : input.textMin;
        const read = ratio(text, under);
        if (read < min) problems.push(`text in ${selector} (${name(el)} "${(el.textContent ?? '').trim().slice(0, 30)}") is ${hex(text)} on ${hex(under)}: ${read.toFixed(2)} < ${min}`);
      }
    }
  }
  for (const value of unparsed) problems.push(`could not read the colour ${value}`);
  return { problems, measured: [...measured] };
}
