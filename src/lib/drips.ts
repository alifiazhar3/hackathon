import { findRhythm, tolerance } from "@/lib/rhythm";

export type Source = "mic" | "camera" | "tap";
export type Confidence = "high" | "medium" | "low";
export type Unit = "gal" | "l";

export type Measurement = {
  source: Source;
  /** detected events that fit the drip rhythm */
  drops: number;
  /** everything the detector picked up, drops or not */
  events: number;
  durationMs: number;
  dropsPerMin: number | null;
  intervalMs: number | null;
  confidence: Confidence;
  reason: string | null;
  /** set when the leak is a steady stream, measured by timing how long it takes to fill a container */
  stream?: { containerMl: number; seconds: number; mlPerMin: number };
};

/** volume of one faucet drop, as assumed by the usgs drip calculator */
export const DROP_ML = 0.25;
export const LITERS_PER_GAL = 3.78541;
/** fix if the leak costs more than the repair within this many days */
export const FIX_HORIZON_DAYS = 365;

export const PERIODS: [label: string, days: number][] = [
  ["day", 1],
  ["week", 7],
  ["month", 30.44],
  ["year", 365],
];

const EVENT_WORD: Record<Source, string> = { mic: "sounds", camera: "falling objects", tap: "taps" };
/** timing resolution of each source: one video frame, or human tapping */
export const TIMING_FLOOR_MS: Record<Source, number> = { mic: 20, camera: 40, tap: 60 };

/**
 * whether a rhythm this strong could come from randomly timed events: the same
 * number of events are scattered at random many times, and the real rhythm
 * has to beat every one of those
 */
function beatsChance(score: number, events: number, durationMs: number, floorMs: number) {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let k = 0; k < 20; k++) {
    const shuffled = Array.from({ length: events }, () => random() * durationMs);
    if (findRhythm(shuffled, floorMs).score >= score) return false;
  }
  return true;
}

/** turns detected event times (ms) into a drip rate and a confidence level */
export function analyze(source: Source, onsets: number[], durationMs: number): Measurement {
  const events = onsets.length;
  const floorMs = TIMING_FLOOR_MS[source];
  const rhythm = findRhythm(onsets, floorMs);
  const drops = rhythm.matched.length;
  const base = { source, drops, events, durationMs };

  if (rhythm.intervalMs === null) {
    return {
      ...base,
      dropsPerMin: null,
      intervalMs: null,
      confidence: "low",
      reason:
        events === 0
          ? source === "camera"
            ? "no falling drops seen"
            : "no drops detected"
          : events < 3
            ? `only ${events} ${EVENT_WORD[source]} detected`
            : `no steady drip rhythm among the ${events} ${EVENT_WORD[source]} detected`,
    };
  }

  // share of the drops the rhythm predicts that were actually detected
  const coverage = drops / rhythm.expected;
  // how often a random event would land on a predicted drop by luck alone
  const eventsPerMs = events / Math.max(durationMs, 1);
  const chance = 1 - Math.exp(-eventsPerMs * 2 * tolerance(rhythm.intervalMs, 1, floorMs));
  const minDrops = source === "tap" ? 4 : 5;

  const span = Math.max(durationMs, onsets.length ? Math.max(...onsets) - Math.min(...onsets) : 0);
  const random = drops < events && !beatsChance(rhythm.score, events, span, floorMs);

  let confidence: Confidence = "low";
  if (random) confidence = "low";
  else if (drops >= 6 && coverage >= Math.max(0.7, chance + 0.45) && rhythm.jitter <= 0.08) confidence = "high";
  else if (drops >= minDrops && coverage >= Math.max(0.55, chance + 0.35) && rhythm.jitter <= 0.15) confidence = "medium";

  return {
    ...base,
    dropsPerMin: 60000 / rhythm.intervalMs,
    intervalMs: rhythm.intervalMs,
    confidence,
    reason:
      confidence !== "low"
        ? null
        : random
          ? `the ${EVENT_WORD[source]} detected were randomly timed, not a steady drip`
          : drops < minDrops
          ? `only ${drops} ${EVENT_WORD[source]} fit a steady rhythm`
          : `the ${EVENT_WORD[source]} detected didn't keep a steady rhythm`,
  };
}

/**
 * a steady stream can't be counted drop by drop, so it is measured by filling
 * a container. the flow is expressed as the equivalent drops per minute so the
 * cost math works the same way.
 */
export function streamMeasurement(containerMl: number, seconds: number): Measurement {
  const mlPerMin = (containerMl / seconds) * 60;
  const dropsPerMin = mlPerMin / DROP_ML;
  return {
    source: "camera",
    drops: 0,
    events: 0,
    durationMs: seconds * 1000,
    dropsPerMin,
    intervalMs: 60000 / dropsPerMin,
    confidence: "high",
    reason: null,
    stream: { containerMl, seconds, mlPerMin },
  };
}

export function litersPerDay(dropsPerMin: number) {
  return (dropsPerMin * 60 * 24 * DROP_ML) / 1000;
}

export function toLiters(amount: number, unit: Unit) {
  return unit === "gal" ? amount * LITERS_PER_GAL : amount;
}

export function fromLiters(liters: number, unit: Unit) {
  return unit === "gal" ? liters / LITERS_PER_GAL : liters;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatDuration(days: number) {
  if (days < 1) return plural(Math.max(1, Math.round(days * 24)), "hour");
  if (days < 14) return plural(Math.round(days), "day");
  if (days < 61) return plural(Math.round(days / 7), "week");
  if (days < 730) return plural(Math.round(days / 30.44), "month");
  if (days < 3650) return `${(days / 365).toFixed(1)} years`;
  return `${Math.round(days / 365).toLocaleString("en-US")} years`;
}

export function formatMoney(x: number) {
  if (x > 0 && x < 0.01) return "<$0.01";
  if (x < 100) return `$${x.toFixed(2)}`;
  return `$${Math.round(x).toLocaleString("en-US")}`;
}

export function formatVolume(liters: number, unit: Unit) {
  const v = fromLiters(liters, unit);
  const n = v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US");
  return `${n} ${unit}`;
}

export function formatRate(dropsPerMin: number) {
  return dropsPerMin < 10 ? dropsPerMin.toFixed(1) : String(Math.round(dropsPerMin));
}
