/**
 * how urgently a leak should be fixed. every leak is worth fixing; this
 * models what waiting costs, assuming the drip slowly gets worse, and how much
 * risk the leak's location adds beyond the water itself.
 */

/** drips tend to worsen as washers and seals wear; assumed growth in rate per month */
export const MONTHLY_GROWTH = 0.05;
/** the drip rate is assumed never to grow past this many times today's */
export const MAX_GROWTH = 5;
const DAYS_PER_MONTH = 30.44;

export type Location = "sink" | "hidden" | "wall";

export const LOCATIONS: { id: Location; label: string }[] = [
  { id: "sink", label: "a tap over a sink or tub" },
  { id: "hidden", label: "under a sink or on a pipe" },
  { id: "wall", label: "behind a wall or ceiling" },
];

/** fix it today, or wait this long */
export const WAITS: [label: string, days: number][] = [
  ["today", 0],
  ["in a month", DAYS_PER_MONTH],
  ["in 3 months", DAYS_PER_MONTH * 3],
  ["in 6 months", DAYS_PER_MONTH * 6],
  ["in a year", 365],
];

/** how many times today's rate the drip is running after this many days */
export function rateMultiplier(days: number, growth = MONTHLY_GROWTH) {
  return Math.min(MAX_GROWTH, (1 + growth) ** (days / DAYS_PER_MONTH));
}

/** water cost of leaving the leak for this many days while it worsens */
export function costOfWaiting(costPerDay: number, days: number, growth = MONTHLY_GROWTH) {
  let total = 0;
  const whole = Math.floor(days);
  for (let d = 0; d < whole; d++) total += costPerDay * rateMultiplier(d + 0.5, growth);
  total += costPerDay * rateMultiplier(whole, growth) * (days - whole);
  return total;
}

/** days until the water wasted (while worsening) has cost more than the repair; Infinity if over 10 years */
export function breakEvenDays(costPerDay: number, repair: number, growth = MONTHLY_GROWTH) {
  if (costPerDay <= 0) return Infinity;
  if (repair <= 0) return 0;
  let total = 0;
  for (let d = 0; d < 3650; d++) {
    const today = costPerDay * rateMultiplier(d + 0.5, growth);
    if (total + today >= repair) return d + (repair - total) / today;
    total += today;
  }
  return Infinity;
}

export type Urgency = "now" | "month" | "soon";

/** a drip this fast (2 a second) is close to a stream */
const FAST_DROPS_PER_MIN = 120;

export function urgency({
  dropsPerMin,
  location,
  breakEven,
  stream,
}: {
  dropsPerMin: number;
  location: Location;
  breakEven: number;
  stream: boolean;
}): { level: Urgency; reasons: string[] } {
  const reasons: string[] = [];
  if (location === "hidden") reasons.push("a leak under a sink or on a pipe can rot cabinets and floors and grow mould unseen");
  if (location === "wall") reasons.push("a leak behind a wall or ceiling can cause damage that costs far more than the water");
  if (stream) reasons.push("it's a steady stream, not a drip");
  else if (dropsPerMin >= FAST_DROPS_PER_MIN) reasons.push("it's dripping more than twice a second");
  if (breakEven <= 90) reasons.push("the wasted water costs more than the repair within 3 months");
  if (reasons.length) return { level: "now", reasons };

  if (breakEven <= 365) {
    return { level: "month", reasons: ["the wasted water costs more than the repair within a year, and it's getting worse"] };
  }
  return {
    level: "soon",
    reasons: ["it's slow and over a sink, so it's cheap for now, but worn seals only get worse and the water is wasted either way"],
  };
}

/** litres used by everyday things, to make wasted water easy to picture */
export const DRINKING_LITERS_PER_DAY = 2;
export const SHOWER_LITERS = 65;
