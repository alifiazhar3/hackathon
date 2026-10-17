export type Source = "mic" | "camera" | "tap";
export type Confidence = "high" | "medium" | "low";
export type Unit = "gal" | "l";

export type Measurement = {
  source: Source;
  drops: number;
  durationMs: number;
  dropsPerMin: number | null;
  intervalMs: number | null;
  confidence: Confidence;
  reason: string | null;
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

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** turns drop timestamps (ms) into a rate and a confidence level */
export function analyze(source: Source, onsets: number[], durationMs: number): Measurement {
  const drops = onsets.length;
  const base = { source, drops, durationMs };

  if (drops < 3) {
    return {
      ...base,
      dropsPerMin: null,
      intervalMs: null,
      confidence: "low",
      reason: drops === 0 ? "no drops detected" : `only ${drops} drop${drops === 1 ? "" : "s"} detected`,
    };
  }

  const intervals = onsets.slice(1).map((t, i) => t - onsets[i]);
  const intervalMs = median(intervals);
  // robust spread of the gaps between drops, relative to the typical gap
  const spread = (median(intervals.map((x) => Math.abs(x - intervalMs))) * 1.4826) / intervalMs;

  let confidence: Confidence = "low";
  if (drops >= 6 && spread < 0.25) confidence = "high";
  else if (drops >= 4 && spread < 0.5) confidence = "medium";

  return {
    ...base,
    dropsPerMin: 60000 / intervalMs,
    intervalMs,
    confidence,
    reason:
      confidence !== "low"
        ? null
        : drops < 4
          ? `only ${drops} drops detected`
          : "the timing between sounds was irregular, so some may not be drops",
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
