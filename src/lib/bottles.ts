/** bottle sizes, biggest first: each stands for 10× the one before */
export const BOTTLE_TIERS = [100_000, 10_000, 1_000, 100, 10, 1] as const;

/** how much bigger each size is drawn than a normal bottle */
export const TIER_SCALE: Record<number, number> = {
  1: 1,
  10: 1.35,
  100: 1.8,
  1_000: 2.4,
  10_000: 3.2,
  100_000: 4.2,
};

/** bottles of one size; fills are 1 for full bottles, less for the last partly filled one */
export type BottleGroup = { size: number; fills: number[] };

/** e.g. "3 × 1,000", "5 normal bottles", or "part of a bottle" */
export function groupLabel(g: BottleGroup) {
  const full = g.fills.filter((f) => f >= 1).length;
  const partial = g.fills.length > full;
  if (g.size === 1) {
    if (full === 0) return "part of a bottle";
    return `${full}${partial ? "+" : ""} normal bottle${full === 1 && !partial ? "" : "s"}`;
  }
  return `${full} × ${g.size.toLocaleString("en-US")}`;
}

/**
 * splits a number of bottles into place values, e.g. 13,855 bottles =
 * one 10,000-bottle, three 1,000s, eight 100s, five 10s and five normal bottles
 */
export function bottleGroups(bottles: number): BottleGroup[] {
  const groups: BottleGroup[] = [];
  let rest = Math.max(0, bottles);
  for (const size of BOTTLE_TIERS) {
    const count = Math.floor(rest / size + 1e-9);
    if (count > 0) groups.push({ size, fills: Array(count).fill(1) });
    rest -= count * size;
  }
  if (rest > 0.01 || groups.length === 0) {
    const ones = groups.find((g) => g.size === 1);
    if (ones) ones.fills.push(rest);
    else groups.push({ size: 1, fills: [rest] });
  }
  return groups;
}
