/**
 * finds the drip rhythm in a list of detected events.
 *
 * real drips repeat at a roughly steady interval, but not a perfect one: the
 * gap from one drop to the next wobbles by 10–20%, and the rate can drift a
 * little over a clip. so instead of demanding drops land exactly on a beat,
 * this looks at the gaps between consecutive events. each gap should be about
 * one beat long, or two or three if drops were missed. every candidate beat
 * length is scored by how many gaps fit it (a one-beat gap counts fully, a
 * two-beat gap half, and so on), so the true beat wins over its half and its
 * double. the rate is the total time of the fitting gaps over their beats.
 */

const MIN_INTERVAL_MS = 120;
const MAX_INTERVAL_MS = 60_000;
/** a gap may span up to this many beats (drops missed in between) */
const MAX_SKIP = 3;
/** a gap fits if it is within this share of a beat from a whole number of beats */
const GAP_FIT = 0.3;
/** how far a single drop may land from where the rhythm predicts, as a share of an interval */
export const TOLERANCE_SHARE = 0.2;
/** with stray events about, prefer a beat twice as long if it scores at least this share as well */
const DOUBLE_PREFERENCE = 0.6;

export type Rhythm = {
  /** typical time between drops, or null if no rhythm was found */
  intervalMs: number | null;
  /** the events that fit the rhythm */
  matched: number[];
  /** drops expected between the first and last matched event */
  expected: number;
  /** drop-to-drop timing spread, relative to the interval */
  jitter: number;
  /** strength of the rhythm: fitting gaps, each weighted by 1 / beats it spans */
  score: number;
  /** share of the gaps between consecutive events that fit the rhythm (random events fit about a third) */
  fitShare: number;
  /** average beats spanned by a fitting gap: near 1 for a drip, higher for noise that fits by chance */
  beatsPerGap: number;
};

const NONE: Rhythm = { intervalMs: null, matched: [], expected: 0, jitter: 0, score: 0, fitShare: 0, beatsPerGap: 0 };

/**
 * how far a drop may land from where the rhythm predicts. floorMs covers the
 * timing resolution of the source: a camera only sees in whole frames, and
 * people tapping along are less exact than a microphone.
 */
export function tolerance(intervalMs: number, skips: number, floorMs = 20) {
  return Math.max(floorMs, TOLERANCE_SHARE * intervalMs) * Math.sqrt(skips);
}

/** how many beats a gap spans at this interval, or 0 if it doesn't fit */
function beatsIn(gap: number, interval: number, floorMs: number) {
  const k = Math.round(gap / interval);
  if (k < 1 || k > MAX_SKIP) return 0;
  const off = Math.abs(gap - k * interval);
  return off <= Math.max(floorMs, GAP_FIT * interval) ? k : 0;
}

/**
 * how much a gap spanning k beats counts. with stray events about, a skipped
 * beat counts little (1 / k), so noise between drops can't fake a faster beat.
 * events already confirmed by two sensors have no strays, so a skipped beat
 * can count more, keeping the true beat from losing to its double.
 */
export type SkipWeighting = "strict" | "clean";
const weight = (k: number, w: SkipWeighting) => (w === "clean" ? [0, 1, 0.8, 0.6][k] : 1 / k);

function scoreOf(gaps: number[], interval: number, floorMs: number, w: SkipWeighting) {
  let score = 0;
  for (const g of gaps) {
    const k = beatsIn(g, interval, floorMs);
    if (k) score += weight(k, w);
  }
  return score;
}

export function findRhythm(events: number[], floorMs = 20, skips: SkipWeighting = "strict"): Rhythm {
  const times = [...events].sort((a, b) => a - b);
  if (times.length < 3) return NONE;
  const gaps = times.slice(1).map((t, i) => t - times[i]);

  // candidate beats: each gap might be one, two or three beats long
  const candidates = new Set<number>();
  for (const g of gaps) {
    for (let k = 1; k <= MAX_SKIP; k++) {
      const c = Math.round(g / k);
      if (c >= MIN_INTERVAL_MS && c <= MAX_INTERVAL_MS) candidates.add(c);
    }
  }
  let best = 0;
  let bestScore = 0;
  for (const c of candidates) {
    const s = scoreOf(gaps, c, floorMs, skips);
    // on a tie, prefer the longer beat (a shorter one only fits by skipping)
    if (s > bestScore + 1e-9 || (Math.abs(s - bestScore) <= 1e-9 && c > best)) {
      bestScore = s;
      best = c;
    }
  }
  if (!best) return NONE;

  // stray events between drops can make half the true beat look best. if a
  // beat twice as long explains the events nearly as well, it is the drip.
  if (skips === "strict" && best * 2 <= MAX_INTERVAL_MS) {
    let doubleScore = 0;
    let double = best * 2;
    for (const c of candidates) {
      if (Math.abs(c - best * 2) > best * 0.2) continue;
      const sc = scoreOf(gaps, c, floorMs, skips);
      if (sc > doubleScore) {
        doubleScore = sc;
        double = c;
      }
    }
    if (doubleScore >= bestScore * DOUBLE_PREFERENCE) best = double;
  }


  // refine: total time of the fitting gaps over the beats they span, twice
  let interval = best;
  for (let pass = 0; pass < 2; pass++) {
    let span = 0;
    let beats = 0;
    for (const g of gaps) {
      const k = beatsIn(g, interval, floorMs);
      if (k) {
        span += g;
        beats += k;
      }
    }
    if (beats) interval = span / beats;
  }

  const matchedSet = new Set<number>();
  const perBeat: number[] = [];
  let score = 0;
  let beats = 0;
  gaps.forEach((g, i) => {
    const k = beatsIn(g, interval, floorMs);
    if (!k) return;
    matchedSet.add(i);
    matchedSet.add(i + 1);
    perBeat.push(g / k);
    score += weight(k, skips);
    beats += k;
  });
  if (perBeat.length < 2) return NONE;

  const matched = [...matchedSet].sort((a, b) => a - b).map((i) => times[i]);
  const mean = perBeat.reduce((a, b) => a + b, 0) / perBeat.length;
  const sd = Math.sqrt(perBeat.reduce((a, g) => a + (g - mean) ** 2, 0) / perBeat.length);
  return {
    intervalMs: interval,
    matched,
    expected: Math.round((matched[matched.length - 1] - matched[0]) / interval) + 1,
    jitter: sd / interval,
    score,
    fitShare: perBeat.length / gaps.length,
    beatsPerGap: beats / perBeat.length,
  };
}
