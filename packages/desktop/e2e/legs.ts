/**
 * The visual tour's legs: TOUR_LEG=k/n shoots and judges the k-th of n shares
 * of the (theme, size) combinations, and still walks every state, since each
 * state is reached from the ones before it. With no TOUR_LEG one leg owns all.
 * CI runs the legs side by side, one job each.
 */

export interface Leg { readonly index: number; readonly count: number }

export const WHOLE: Leg = { index: 1, count: 1 };

/** `k/n` with 1 <= k <= n; anything else is a mistake in the job that set it, not a reason to walk everything. */
export function parseLeg(value: string | undefined): Leg {
  if (value === undefined || value.trim() === '') return WHOLE;
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`TOUR_LEG=${value}: expected k/n with 1 <= k <= n`);
  return { index, count };
}

export function legName(leg: Leg): string {
  return `${leg.index}/${leg.count}`;
}

/** Every theme with every size, themes outermost: the order one walk shoots them in. */
export function combinations<T, S>(themes: readonly T[], sizes: readonly S[]): { readonly theme: T; readonly size: S }[] {
  return themes.flatMap((theme) => sizes.map((size) => ({ theme, size })));
}

/** The leg that shoots combination `at`: dealt round, so two legs never differ by more than one combination. */
export function ownerOf(at: number, count: number): number {
  return (at % count) + 1;
}

export function owns(leg: Leg, at: number): boolean {
  return ownerOf(at, leg.count) === leg.index;
}

/**
 * Throws unless legs 1..n of `total` combinations share none and leave none
 * out, and none is empty: n legs together shoot what one walk does, once.
 */
export function assertPartition(total: number, count: number): void {
  if (count > total) throw new Error(`${count} legs for ${total} combinations: a leg would shoot nothing`);
  const seen = new Map<number, number[]>();
  for (let index = 1; index <= count; index++) {
    for (let at = 0; at < total; at++) if (owns({ index, count }, at)) seen.set(at, [...(seen.get(at) ?? []), index]);
  }
  const wrong = Array.from({ length: total }, (_, at) => at).filter((at) => seen.get(at)?.length !== 1);
  if (wrong.length) throw new Error(`legs 1..${count} do not partition the combinations: ${wrong.map((at) => `#${at} in [${(seen.get(at) ?? []).join(',')}]`).join(', ')}`);
  for (let index = 1; index <= count; index++) {
    if (![...seen.values()].some((legs) => legs.includes(index))) throw new Error(`leg ${index}/${count} shoots nothing`);
  }
}
