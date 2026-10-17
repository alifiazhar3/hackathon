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

export function tolerance(intervalMs: number, skips: number) {
  return Math.max(20, 0.04 * intervalMs) * Math.sqrt(skips);
}

type Chain = { score: number; indices: number[]; steps: number[] };

function bestChain(times: number[], interval: number): Chain {
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
      if (Math.abs(gap - m * interval) > tolerance(interval, m)) continue;
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

export function findRhythm(events: number[]): Rhythm {
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
  const candidates: number[] = [];
  for (const g of gaps) {
    const last = candidates[candidates.length - 1];
    if (last === undefined || g > last * 1.02) candidates.push(g);
  }

  let best: { chain: Chain; interval: number } | null = null;
  for (const c of candidates) {
    const chain = bestChain(times, c);
    if (!best || chain.score > best.chain.score + 1e-9) best = { chain, interval: c };
  }
  if (!best || best.chain.indices.length < 3) return NONE;

  // refine the interval with a straight-line fit through the chain
  const matched = best.chain.indices.map((i) => times[i]);
  const numbers: number[] = [0];
  for (let k = 1; k < best.chain.steps.length; k++) numbers.push(numbers[k - 1] + best.chain.steps[k]);
  const fit = fitInterval(matched, numbers);
  const intervalMs = fit.slope > 0 ? fit.slope : best.interval;

  return {
    intervalMs,
    matched,
    expected: numbers[numbers.length - 1] + 1,
    jitter: fit.rms / intervalMs,
    score: best.chain.score,
  };
}
