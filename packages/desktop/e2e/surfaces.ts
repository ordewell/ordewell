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

/** How much of an important label's text must show, in px: about ten characters, enough to tell one row from the next. */
export const SHOWN_MIN = 64;

/**
 * Runs in the renderer, as `locator.evaluateAll`'s function: `labels` are the
 * state's important names and titles (design.md, Layout rule 3). Each must show
 * at least `shownMin` px of its text, or all of it when shorter, and each of
 * its parts (a name, its path) at least half that; a text cut by
 * an ellipsis, a clamp or a clipping ancestor must carry a tooltip; and each
 * text must read at `textMin`:1 on what is painted under it. It repeats
 * liftChecks' colour arithmetic, since a function sent to the page takes
 * nothing from this module. A label scrolled away is scrolled to and back,
 * with any scroll snapping held off meanwhile.
 *
 * The tooltip is a native `title`, or a disclosure the keyboard opens: a cut
 * text with no title inside a focusable part of the label is focused, and
 * passes only when the focus describes it (`aria-describedby`) with a shown
 * element that holds the text whole, uncut (a line of facts set apart by
 * " · " fact by fact), which closes again once focus leaves or on Escape. Focus is then put back, unless it was on that part,
 * whose focus is what opens it.
 */
export async function labelChecks(labels: Element[], input: { textMin: number; shownMin: number }): Promise<string[]> {
  type Rgba = [number, number, number, number];
  const parse = (value: string): Rgba | undefined => {
    const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
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
  const backdrop = (el: Element): Rgba => {
    const layers: Rgba[] = [];
    for (let at: Element | null = el; at; at = at.parentElement) {
      const fill = parse(getComputedStyle(at).backgroundColor) ?? [0, 0, 0, 0];
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] >= 1) break;
    }
    return layers.reverse().reduce<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
  };
  const shown = (el: Element): boolean => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  /** `rect` cut by `from` and every ancestor that clips, and by the viewport. */
  const clip = (rect: DOMRect, from: Element): { width: number; height: number } => {
    let { left, top, right, bottom } = rect;
    for (let at: Element | null = from; at; at = at.parentElement) {
      const s = getComputedStyle(at);
      const r = at.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, r.left); right = Math.min(right, r.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); }
      if (s.position === 'fixed') break;
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, window.innerWidth);
    bottom = Math.min(bottom, window.innerHeight);
    return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };
  const scrolled: [Element, number, number][] = [];
  // A mandatory snap pulls scrollIntoView back to the nearest snap point, which can leave
  // the label still cut at the scroller's edge (the plan graph snaps to stage starts).
  // Snapping is suspended while the labels are brought to view, so each is measured as
  // presented in full; what clips it itself, or an ancestor that cannot scroll, still counts.
  const snaps = new Map<HTMLElement, string>();
  for (const label of labels) {
    for (let at = label.parentElement; at; at = at.parentElement) {
      if (at.scrollHeight <= at.clientHeight && at.scrollWidth <= at.clientWidth) continue;
      scrolled.push([at, at.scrollTop, at.scrollLeft]);
      if (at instanceof HTMLElement && !snaps.has(at) && getComputedStyle(at).scrollSnapType !== 'none') snaps.set(at, at.style.scrollSnapType);
    }
  }
  for (const el of snaps.keys()) el.style.scrollSnapType = 'none';

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  /** Cut texts with no title, each inside a part of its label that takes focus: judged by what that focus discloses. */
  const untitled: { opener: HTMLElement; full: string; name: string; problem: string }[] = [];
  const problems: string[] = [];
  for (const label of labels) {
    const name = (label.getAttribute('aria-label') ?? label.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!shown(label)) { problems.push(`"${name}" is not shown`); continue; }
    label.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const leaves = [label, ...label.querySelectorAll('*')].filter((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')
      && shown(el) && el.closest('svg, .sr-only') === null);
    if (leaves.length === 0) { problems.push(`"${name}" shows no text`); continue; }
    let natural = 0;
    let visible = 0;
    for (const leaf of leaves) {
      const text = (leaf.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      // Its own text's extent, laid out in full: an ellipsis or a clamp only stops it being painted.
      let whole: DOMRect | undefined;
      for (const node of leaf.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() === '') continue;
        const range = document.createRange();
        range.selectNode(node);
        const r = range.getBoundingClientRect();
        whole = whole ? new DOMRect(Math.min(whole.left, r.left), Math.min(whole.top, r.top), Math.max(whole.right, r.right) - Math.min(whole.left, r.left), Math.max(whole.bottom, r.bottom) - Math.min(whole.top, r.top)) : r;
      }
      if (!whole) continue;
      const seen = clip(whole, leaf);
      natural += whole.width;
      visible += seen.width;
      const block = getComputedStyle(leaf).display !== 'inline';
      const cut = seen.width < whole.width - 1 || seen.height < whole.height - 1
        || (block && (leaf.scrollWidth > leaf.clientWidth + 1 || leaf.scrollHeight > leaf.clientHeight + 1));
      // Each part keeps a few characters: a path squeezed to nothing beside its name no longer tells two folders apart.
      if (seen.width < Math.min(whole.width, input.shownMin / 2) - 1) problems.push(`"${name}": "${text}" is squeezed to ${Math.round(seen.width)}px`);
      const titled = leaf.closest('[title]');
      if (cut && !(titled && (titled === label || label.contains(titled)) && titled.getAttribute('title')?.trim())) {
        const opener = leaf.closest(FOCUSABLE);
        const full = (leaf.textContent ?? '').trim().replace(/\s+/g, ' ');
        const problem = `"${name}": "${text}" is cut short with no tooltip`;
        if (opener instanceof HTMLElement && (opener === label || label.contains(opener))) untitled.push({ opener, full, name, problem });
        else problems.push(problem);
      }
      if (leaf.closest('[disabled], [aria-disabled="true"]')) continue;
      const style = getComputedStyle(leaf);
      const color = parse(style.color);
      if (!color) { problems.push(`"${name}": could not read the colour ${style.color}`); continue; }
      const under = backdrop(leaf);
      const read = ratio(over(color, under), under);
      const size = parseFloat(style.fontSize);
      const min = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : input.textMin;
      if (read < min) problems.push(`"${name}": "${text}" is ${hex(over(color, under))} on ${hex(under)}: ${read.toFixed(2)} < ${min}`);
    }
    if (visible < Math.min(natural, input.shownMin) - 1) problems.push(`"${name}" shows ${Math.round(visible)}px of its ${Math.round(natural)}px of text`);
  }
  for (const [el, top, left] of scrolled.reverse()) { el.scrollTop = top; el.scrollLeft = left; }
  // Back on the position it was snapped to, the scroller snaps again as it did.
  for (const [el, inline] of snaps) el.style.scrollSnapType = inline;
  if (untitled.length > 0) problems.push(...await disclosures());
  return problems;

  /** Each opener focused in turn, without scrolling: what its focus describes must hold the cut text whole. */
  async function disclosures(): Promise<string[]> {
    // A frame, or 50ms where a hidden window draws none: React's render and a scroll's event both land on one.
    const tick = (): Promise<void> => new Promise((resolve) => {
      const timer = setTimeout(resolve, 50);
      requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    });
    const until = async (done: () => boolean, ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; !done();) {
        if (Date.now() > end) return false;
        await tick();
      }
      return true;
    };
    const described = (opener: HTMLElement): HTMLElement[] => (opener.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .map((id) => (id ? document.getElementById(id) : null))
      .filter((el): el is HTMLElement => el !== null && el.isConnected && el.getClientRects().length > 0 && shown(el) && el.closest('.sr-only, .visually-hidden') === null);
    const found: string[] = [];
    const before = document.activeElement;
    // The scrolls that brought labels to view and back fire their events first, which may close what a focus opens.
    await tick();
    await tick();
    const byOpener = new Map<HTMLElement, { full: string; name: string; problem: string }[]>();
    for (const cut of untitled) byOpener.set(cut.opener, [...(byOpener.get(cut.opener) ?? []), cut]);
    for (const [opener, cuts] of byOpener) {
      // Its own focus may be the pointer's, which opens nothing: it is taken from the keyboard afresh.
      if (document.activeElement === opener) opener.blur();
      await tick();
      opener.focus({ preventScroll: true });
      const open = await until(() => described(opener).length > 0, 2000);
      const descriptions = described(opener);
      for (const { full, problem } of cuts) {
        if (!open) { found.push(`${problem}: focusing it discloses nothing`); continue; }
        // A line of facts set apart by " · " (an age, an author, a sha) may be told fact by fact, each where it
        // belongs. Each part needs the description's innermost element that holds it whole to show all of that.
        const shortfalls = full.split(' · ').filter((part) => part.trim() !== '').map((part) => {
          const holds = (el: Element): boolean => (el.textContent ?? '').replace(/\s+/g, ' ').includes(part);
          const holder = descriptions.flatMap((d) => [d, ...d.querySelectorAll('*')]).find((el) => holds(el) && ![...el.children].some(holds));
          if (!holder) return 'does not hold it';
          const rect = holder.getBoundingClientRect();
          const seen = clip(rect, holder);
          const block = getComputedStyle(holder).display !== 'inline';
          return seen.width < rect.width - 1 || seen.height < rect.height - 1 || (block && (holder.scrollWidth > holder.clientWidth + 1 || holder.scrollHeight > holder.clientHeight + 1))
            ? 'cuts it too' : undefined;
        });
        const shortfall = shortfalls.find((s) => s === 'does not hold it') ?? shortfalls.find((s) => s !== undefined);
        if (shortfall) found.push(`${problem}: what focusing it discloses ${shortfall}`);
      }
      opener.blur();
      // Closing on blur waits out a grace period, and a pointer resting on the row keeps it open: Escape then dismisses it.
      if (open && !await until(() => described(opener).length === 0, 1000)) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        if (!await until(() => described(opener).length === 0, 1000)) found.push(`"${cuts[0]!.name}": what focusing it discloses stays open after focus leaves and Escape`);
      }
    }
    if (before instanceof HTMLElement && !byOpener.has(before) && before !== document.activeElement) before.focus({ preventScroll: true });
    return found;
  }
}
