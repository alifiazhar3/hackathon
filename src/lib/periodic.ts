/**
 * finds a repeating rhythm in a signal over time, such as how much a column
 * of the picture changes from frame to frame.
 *
 * counting drops one at a time needs each drop to stand out. in slow motion,
 * in a close-up, or with tiny drops it often doesn't: the drop swells and
 * stretches for many frames. but a drip still makes the signal rise and fall
 * once per drop, so the time it takes to repeat itself is the drip interval.
 */

/** the signal is resampled to this rate */
const RATE_HZ = 30;
const MIN_PERIOD_MS = 250;
const MAX_PERIOD_MS = 8000;
/** the clip must hold at least this many repeats */
const MIN_REPEATS = 2.5;
/** slow changes (the camera drifting, light changing) longer than this are removed */
const TREND_MS = 3000;

export type Period = {
  /** time between repeats, or null if there's no clear rhythm */
  periodMs: number | null;
  /** how alike the signal is one period apart (0 none, 1 identical) */
  strength: number;
};

const NONE: Period = { periodMs: null, strength: 0 };

/** values sampled at times (ms), resampled evenly, slow trend removed */
function prepare(times: number[], values: number[]) {
  const start = times[0];
  const end = times[times.length - 1];
  const n = Math.floor(((end - start) / 1000) * RATE_HZ) + 1;
  const even = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = start + (i * 1000) / RATE_HZ;
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const span = times[j + 1] - times[j] || 1;
    const f = Math.min(1, Math.max(0, (t - times[j]) / span));
    // compressed, so one huge splash doesn't drown out the rest
    even[i] = Math.log1p((1 - f) * values[j] + f * values[j + 1]);
  }
  const half = Math.round(((TREND_MS / 1000) * RATE_HZ) / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + even[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = even[i] - (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

/** how alike the signal is with itself `lag` samples later (-1..1) */
function alike(x: Float64Array, lag: number) {
  let sum = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i + lag < x.length; i++) {
    sum += x[i] * x[i + lag];
    a2 += x[i] * x[i];
    b2 += x[i + lag] * x[i + lag];
  }
  return a2 && b2 ? sum / Math.sqrt(a2 * b2) : 0;
}

/** the repeat time of the signal, if it clearly repeats */
export function findPeriod(times: number[], values: number[]): Period {
  if (times.length < 20) return NONE;
  const x = prepare(times, values);
  const durationMs = times[times.length - 1] - times[0];
  const minLag = Math.round((MIN_PERIOD_MS / 1000) * RATE_HZ);
  const maxLag = Math.min(Math.round((MAX_PERIOD_MS / 1000) * RATE_HZ), Math.floor(((durationMs / MIN_REPEATS) / 1000) * RATE_HZ));
  if (maxLag <= minLag + 2) return NONE;

  const top = Math.min(2 * maxLag + 2, x.length - 10);
  const r = new Float64Array(top + 2);
  for (let lag = 1; lag <= top; lag++) r[lag] = alike(x, lag);

  // peaks: higher than their neighbours, after the signal first stops being alike to itself
  let firstDip = 1;
  while (firstDip < maxLag && r[firstDip] > 0.2) firstDip++;
  const peaks: number[] = [];
  for (let lag = Math.max(minLag, firstDip); lag <= maxLag; lag++) {
    if (r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] && r[lag] > 0) peaks.push(lag);
  }
  if (!peaks.length) return NONE;
  const best = Math.max(...peaks.map((l) => r[l]));
  // the shortest repeat that is nearly as strong as the best: longer ones are its multiples
  const lag = peaks.find((l) => r[l] >= best * 0.85)!;
  // refine between samples
  const a = r[lag - 1];
  const b = r[lag];
  const c = r[lag + 1];
  const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  const periodMs = ((lag + Math.max(-0.5, Math.min(0.5, shift))) * 1000) / RATE_HZ;

  // a real rhythm repeats again at twice the period
  const twice = Math.round(lag * 2);
  const again = twice + 1 <= top ? Math.max(r[twice - 1] ?? 0, r[twice] ?? 0, r[twice + 1] ?? 0) : b;
  return { periodMs, strength: Math.min(b, again + 0.1) };
}

/** windows this long are also checked, for a drip that only runs for part of the clip */
const WINDOW_MS = 8000;

/** the clearest rhythm in the whole signal or in any part of it */
export function findPeriodAnywhere(times: number[], values: number[]): Period {
  let best = findPeriod(times, values);
  const start = times[0];
  const end = times[times.length - 1];
  if (end - start < WINDOW_MS * 1.5) return best;
  for (let from = start; from + WINDOW_MS <= end + 1; from += WINDOW_MS / 2) {
    const a = times.findIndex((t) => t >= from);
    let b = a;
    while (b < times.length && times[b] < from + WINDOW_MS) b++;
    const part = findPeriod(times.slice(a, b), values.slice(a, b));
    // a part has to be clearly better than the whole to win
    if (part.periodMs !== null && part.strength > best.strength + 0.15) best = part;
  }
  return best;
}
