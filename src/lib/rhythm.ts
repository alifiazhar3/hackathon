/**
 * finds the steady drip rhythm in a list of detected events.
 *
 * real drips repeat at a near-constant interval; background noise doesn't.
 * we try candidate intervals taken from the gaps between events, and for each
 * one find the longest chain of events spaced by whole multiples of it
 * (a multiple means some drops in between were missed). gaps that skip drops
 * cost a little, so the true interval beats its halves and doubles.
 */

const MIN_INTERVAL_MS = 120;
const MAX_INTERVAL_MS = 60_000;
/** how many missed drops in a row a chain may bridge */
const MAX_SKIP = 4;
const SKIP_PENALTY = 0.6;
/** how many of the most common gaps between events to try as the drip interval */
const MAX_CANDIDATES = 30;
/** a restarted rhythm counts if it has at least this many drops... */
const MIN_SEGMENT = 4;
/** ...and the rhythm may restart at most this many times */
const MAX_SEGMENTS = 3;

export type Rhythm = {
  /** typical time between drops, or null if no rhythm was found */
  intervalMs: number | null;
  /** the events that fit the rhythm */
  matched: number[];
  /** drops expected between the first and last matched event */
  expected: number;
  /** timing spread of matched events, relative to the interval */
  jitter: number;
  /** chain strength: matched events minus a penalty for each missed drop */
  score: number;
};

const NONE: Rhythm = { intervalMs: null, matched: [], expected: 0, jitter: 0, score: 0 };

/**
 * how far a drop may land from where the rhythm predicts. floorMs covers the
 * timing resolution of the source: a camera only sees in whole frames, and
 * people tapping along are less exact than a microphone.
 */
export function tolerance(intervalMs: number, skips: number, floorMs = 20) {
  return Math.max(floorMs, 0.04 * intervalMs) * Math.sqrt(skips);
}

type Chain = { score: number; indices: number[]; steps: number[] };

function bestChain(times: number[], interval: number, floorMs: number): Chain {
  const n = times.length;
  const score = new Float64Array(n).fill(1);
  const prev = new Int32Array(n).fill(-1);
  const step = new Int32Array(n);

  for (let i = 1; i < n; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const gap = times[i] - times[j];
      if (gap > (MAX_SKIP + 0.5) * interval) break;
      const m = Math.round(gap / interval);
      if (m < 1) continue;
      if (Math.abs(gap - m * interval) > tolerance(interval, m, floorMs)) continue;
      const s = score[j] + 1 - SKIP_PENALTY * (m - 1);
      if (s > score[i]) {
        score[i] = s;
        prev[i] = j;
        step[i] = m;
      }
    }
  }

  let end = 0;
  for (let i = 1; i < n; i++) if (score[i] > score[end]) end = i;
  const indices: number[] = [];
  const steps: number[] = [];
  for (let i = end; i >= 0; i = prev[i]) {
    indices.push(i);
    steps.push(step[i]);
  }
  indices.reverse();
  steps.reverse();
  return { score: score[end], indices, steps };
}

/** least-squares slope of event times against their drop numbers */
function fitInterval(times: number[], numbers: number[]) {
  const n = times.length;
  const mx = numbers.reduce((a, b) => a + b, 0) / n;
  const my = times.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (numbers[i] - mx) * (times[i] - my);
    sxx += (numbers[i] - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let residual = 0;
  for (let i = 0; i < n; i++) residual += (times[i] - (intercept + slope * numbers[i])) ** 2;
  return { slope, rms: Math.sqrt(residual / n) };
}

export function findRhythm(events: number[], floorMs = 20): Rhythm {
  const times = [...events].sort((a, b) => a - b);
  if (times.length < 3) return NONE;

  // candidate intervals: gaps between nearby events, merged when within 2%
  const gaps: number[] = [];
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < Math.min(times.length, i + 5); j++) {
      const g = times[j] - times[i];
      if (g >= MIN_INTERVAL_MS && g <= MAX_INTERVAL_MS) gaps.push(g);
    }
  }
  gaps.sort((a, b) => a - b);
  const clusters: { sum: number; count: number; first: number }[] = [];
  for (const g of gaps) {
    const last = clusters[clusters.length - 1];
    if (last && g <= last.first * 1.02) {
      last.sum += g;
      last.count++;
    } else {
      clusters.push({ sum: g, count: 1, first: g });
    }
  }
  // a real drip repeats its interval many times, so only the most common
  // intervals are worth trying (this keeps noisy rooms fast)
  const candidates = clusters
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.sum / c.count);

  let best: { chain: Chain; interval: number } | null = null;
  for (const c of candidates) {
    const chain = bestChain(times, c, floorMs);
    if (!best || chain.score > best.chain.score + 1e-9) best = { chain, interval: c };
  }
  if (!best || best.chain.indices.length < 3) return NONE;

  // the rhythm can restart after a jump (a bumped phone, a looped video): look
  // for more runs at the same interval among the events left over
  const segments: { times: number[]; numbers: number[] }[] = [];
  let rest = times;
  let chain = best.chain;
  let score = 0;
  while (segments.length < MAX_SEGMENTS) {
    const segTimes = chain.indices.map((i) => rest[i]);
    const numbers: number[] = [0];
    for (let k = 1; k < chain.steps.length; k++) numbers.push(numbers[k - 1] + chain.steps[k]);
    segments.push({ times: segTimes, numbers });
    score += chain.score;
    const used = new Set(chain.indices);
    rest = rest.filter((_, i) => !used.has(i));
    if (rest.length < MIN_SEGMENT) break;
    // one tap drips one rhythm at a time, so a restart can only happen
    // before or after the runs found so far, never in the middle of one
    const spans = segments.map((seg) => [seg.times[0], seg.times[seg.times.length - 1]]);
    rest = rest.filter((t) => spans.every(([a, b]) => t < a || t > b));
    if (rest.length < MIN_SEGMENT) break;
    chain = bestChain(rest, best.interval, floorMs);
    if (chain.indices.length < Math.max(MIN_SEGMENT, segments[0].times.length * 0.25)) break;
  }

  // refine the interval with one straight-line slope shared by every run
  let sxy = 0;
  let sxx = 0;
  for (const seg of segments) {
    const mx = seg.numbers.reduce((a, b) => a + b, 0) / seg.numbers.length;
    const my = seg.times.reduce((a, b) => a + b, 0) / seg.times.length;
    seg.numbers.forEach((n, i) => {
      sxy += (n - mx) * (seg.times[i] - my);
      sxx += (n - mx) ** 2;
    });
  }
  const intervalMs = sxx > 0 && sxy > 0 ? sxy / sxx : best.interval;
  let residual = 0;
  let count = 0;
  for (const seg of segments) {
    const fit = fitInterval(seg.times, seg.numbers);
    residual += fit.rms ** 2 * seg.times.length;
    count += seg.times.length;
  }

  return {
    intervalMs,
    matched: segments.flatMap((seg) => seg.times).sort((a, b) => a - b),
    expected: segments.reduce((sum, seg) => sum + seg.numbers[seg.numbers.length - 1] + 1, 0),
    jitter: Math.sqrt(residual / count) / intervalMs,
    score,
  };
}
