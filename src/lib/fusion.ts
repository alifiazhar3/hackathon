/**
 * combines what the camera saw with what the microphone heard.
 *
 * a drop is seen when it lets go of the tap and heard a moment later when it
 * lands, so the two sensors' events line up at a steady gap (plus a little
 * device delay). that gap is learned from the events themselves. a drop seen
 * and heard at that gap is confirmed; a drop caught by only one sensor still
 * counts if it lands on the confirmed rhythm.
 *
 * many videos aren't like that: the sound is out of sync, dubbed from another
 * take, or missing. so the two sensors' own drip rates matter most. if they
 * agree, their average is used; if only one found a drip, it is used; if they
 * disagree, the surer one wins (the picture, on a tie, since it shows the leak).
 * a leak found by either sensor is never thrown away.
 */
import { analyze, type Measurement } from "@/lib/drips";
import { findRhythm, tolerance } from "@/lib/rhythm";

/**
 * the sound may come this long after (or before) the sight: a drop is heard a
 * moment after it is seen, and many videos' sound is a little out of sync.
 * a drip repeats, so even a sound track shifted by several drops still lines up.
 */
const LAG_MIN_MS = -4000;
const LAG_MAX_MS = 4000;
const LAG_BIN_MS = 10;
/** a sound and a sighting this close to the learned gap are the same drop (two video frames) */
const PAIR_TOLERANCE_MS = 60;
/** the gap must be found in at least this many pairs... */
const MIN_PAIRS = 3;
/** ...covering at least this share of the sensor with fewer events */
const MIN_PAIR_SHARE = 0.3;
/** the two sensors' rates must agree this closely */
const RATE_AGREEMENT = 0.1;
const FLOOR_MS = 45;

export type Fused = Measurement & {
  fused: {
    /** gap from seeing a drop to hearing it, or null if they never lined up */
    lagMs: number | null;
    /** drops both seen and heard */
    confirmed: number;
    /** drops only heard, but right on the rhythm */
    heardOnly: number;
    /** drops only seen, but right on the rhythm */
    seenOnly: number;
    sound: Measurement;
    picture: Measurement;
    /** "agree", "disagree", or which single sensor found a rhythm */
    rates: "agree" | "disagree" | "sound only" | "picture only" | "neither";
    /** which sensor the answer came from when they didn't agree */
    chose?: "sound" | "picture";
  };
};

/**
 * each sensor's own result, when it was worked out by more than its event
 * times, and which sensor had nothing to offer at all (a video without sound)
 */
export type Given = { sound?: Measurement; picture?: Measurement; noSound?: boolean; noPicture?: boolean };

/** the most common gap from a sighting to a sound, if there is a clear one */
export function learnLag(seen: number[], heard: number[]): number | null {
  if (!seen.length || !heard.length) return null;
  const bins = new Map<number, number>();
  for (const v of seen) {
    for (const a of heard) {
      const d = a - v;
      if (d < LAG_MIN_MS || d > LAG_MAX_MS) continue;
      const b = Math.round(d / LAG_BIN_MS);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
  }
  let bestBin = 0;
  let bestCount = 0;
  for (const [b, n] of bins) {
    // smooth over neighbouring bins, since timing wobbles a little
    const count = n + (bins.get(b - 1) ?? 0) + (bins.get(b + 1) ?? 0);
    if (count > bestCount) {
      bestCount = count;
      bestBin = b;
    }
  }
  const guess = bestBin * LAG_BIN_MS;
  // refine: average gap of the pairs near the guess
  const near: number[] = [];
  for (const v of seen) {
    let best: number | null = null;
    for (const a of heard) {
      const d = a - v - guess;
      if (Math.abs(d) <= PAIR_TOLERANCE_MS && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) near.push(guess + best);
  }
  if (near.length < MIN_PAIRS || near.length < Math.min(seen.length, heard.length) * MIN_PAIR_SHARE) return null;
  return near.reduce((a, b) => a + b, 0) / near.length;
}

function rateOf(m: Measurement) {
  return m.dropsPerMin !== null && m.confidence !== "low" ? m.dropsPerMin : null;
}

const close = (a: number, b: number, within = RATE_AGREEMENT) => Math.abs(a - b) / ((a + b) / 2) <= within;

/** each sensor's rate, weighted by how many drops it caught and how sure it is */
function average(ms: Measurement[]) {
  let sum = 0;
  let weights = 0;
  for (const m of ms) {
    const w = Math.max(1, m.drops) * (m.confidence === "high" ? 1 : 0.6);
    sum += m.dropsPerMin! * w;
    weights += w;
  }
  return sum / weights;
}

/** seen and heard event times (ms, same clock) over a measurement lasting durationMs */
export function fuse(seen: number[], heard: number[], durationMs: number, given: Given = {}): Fused {
  const sound = given.sound ?? analyze("mic", heard, durationMs);
  const picture = given.picture ?? analyze("camera", seen, durationMs);
  const soundRate = rateOf(sound);
  const pictureRate = rateOf(picture);
  const rates: Fused["fused"]["rates"] =
    soundRate !== null && pictureRate !== null
      ? Math.abs(soundRate - pictureRate) / ((soundRate + pictureRate) / 2) <= RATE_AGREEMENT
        ? "agree"
        : "disagree"
      : soundRate !== null
        ? "sound only"
        : pictureRate !== null
          ? "picture only"
          : "neither";

  const lagMs = learnLag(seen, heard);
  const base = { lagMs, sound, picture, rates };

  if (lagMs === null && rates === "agree") {
    // the drops never lined up one for one, but both sensors found the same drip rate
    const rate = average([sound, picture]);
    return {
      ...(sound.drops >= picture.drops ? sound : picture),
      source: "both",
      dropsPerMin: rate,
      intervalMs: 60000 / rate,
      drops: Math.max(sound.drops, picture.drops),
      confidence: sound.confidence === "high" && picture.confidence === "high" ? "high" : "medium",
      rough: sound.rough && picture.rough,
      reason: null,
      fused: { ...base, confirmed: 0, heardOnly: 0, seenOnly: 0 },
    };
  }

  if (lagMs === null) {
    // the drops never lined up one for one (out of sync, another take, or one sensor
    // found nothing): go with whichever sensor found a drip
    const pick = surer(sound, picture);
    if (pick) return single(pick, pick === sound ? "sound" : "picture", { ...base, confirmed: 0, heardOnly: 0, seenOnly: 0 }, durationMs, pick === sound ? heard : seen, pick === sound ? seen : heard, given);
    return {
      ...analyze("both", [], durationMs),
      events: seen.length + heard.length,
      confidence: "low",
      reason: seen.length + heard.length ? "no steady drip was seen or heard" : "no drops seen or heard",
      fused: { ...base, confirmed: 0, heardOnly: 0, seenOnly: 0 },
    };
  }

  // pair each sighting with the sound at the learned gap
  const usedSound = new Set<number>();
  const confirmed: number[] = [];
  const seenSingles: number[] = [];
  for (const v of seen) {
    let best = -1;
    let bestErr = Infinity;
    heard.forEach((a, i) => {
      if (usedSound.has(i)) return;
      const err = Math.abs(a - v - lagMs);
      if (err <= PAIR_TOLERANCE_MS && err < bestErr) {
        bestErr = err;
        best = i;
      }
    });
    if (best >= 0) {
      usedSound.add(best);
      // sound is timed to a few ms, video only to a frame: time the drop by its sound
      confirmed.push(heard[best] - lagMs);
    } else {
      seenSingles.push(v);
    }
  }
  // heard-only drops, moved onto the sighting timeline
  const heardSingles = heard.filter((_, i) => !usedSound.has(i)).map((a) => a - lagMs);

  // the drops caught by both sensors, on their own, as a check on the others
  const anchor = findRhythm(confirmed, FLOOR_MS, "clean");
  // judged on every seen-and-heard pair, not just the ones that fit, so noise can't flatter itself
  const quality = analyze("both", confirmed, durationMs);
  const anchorRate = anchor.intervalMs !== null && confirmed.length >= 3 && quality.confidence !== "low" ? 60000 / anchor.intervalMs : null;

  // drops one sensor missed, filled in from the other where they land on the beat
  let heardOnly = 0;
  let seenOnly = 0;
  if (anchor.intervalMs !== null) {
    const interval = anchor.intervalMs;
    const matched = [...anchor.matched];
    const first = matched[0];
    const last = matched[matched.length - 1];
    const tol = tolerance(interval, 1, FLOOR_MS);
    const fill = (t: number) => {
      if (t < first - interval / 2 || t > last + interval / 2) return false;
      if (matched.some((m) => Math.abs(m - t) < interval / 2)) return false;
      const nearest = matched.reduce((x, y) => (Math.abs(y - t) < Math.abs(x - t) ? y : x));
      const k = Math.round((t - nearest) / interval);
      if (k === 0 || Math.abs(t - nearest - k * interval) > tol) return false;
      matched.push(t);
      return true;
    };
    for (const t of heardSingles) if (fill(t)) heardOnly++;
    for (const t of seenSingles) if (fill(t)) seenOnly++;
  }
  const fusedInfo = { ...base, confirmed: confirmed.length, heardOnly, seenOnly };

  /**
   * both sensors measure the drip and check each other:
   * - they agree: average them (weighted by drops caught and certainty)
   * - they disagree: the drops both caught decide which one is right
   * - only one found a drip: it counts if the drops both caught back it up
   * - neither did: the drops both caught are the last resort
   */
  let rate: number | null = null;
  let confidence: Measurement["confidence"] = "low";
  let drops = 0;
  let reason: string | null = null;
  const usable = [sound, picture].filter((m) => rateOf(m) !== null);

  if (usable.length === 2 && rates === "agree") {
    rate = average(usable);
    drops = Math.max(sound.drops, picture.drops);
    confidence = confirmed.length >= 3 ? "high" : "medium";
  } else if (usable.length === 2) {
    const backed = anchorRate !== null ? usable.filter((m) => close(m.dropsPerMin!, anchorRate, 0.15)) : [];
    if (backed.length === 1) {
      rate = backed[0].dropsPerMin!;
      drops = backed[0].drops;
      confidence = "medium";
    } else if (anchorRate !== null) {
      // neither matches the drops both caught: those are the most reliable evidence
      rate = anchorRate;
      drops = confirmed.length + heardOnly + seenOnly;
      confidence = "medium";
    } else {
      const pick = surer(sound, picture)!;
      return single(pick, pick === sound ? "sound" : "picture", fusedInfo, durationMs, pick === sound ? heard : seen, pick === sound ? seen : heard, given);
    }
  } else if (usable.length === 1) {
    const only = usable[0];
    if (anchorRate !== null && close(only.dropsPerMin!, anchorRate, 0.15)) {
      rate = average([only, { ...quality, dropsPerMin: anchorRate, drops: confirmed.length }]);
      drops = Math.max(only.drops, confirmed.length + heardOnly + seenOnly);
      confidence = only.confidence === "high" && confirmed.length >= 5 ? "high" : "medium";
    } else if (anchorRate !== null) {
      // the drops both caught point elsewhere: trust them over one sensor
      rate = anchorRate;
      drops = confirmed.length + heardOnly + seenOnly;
      confidence = "medium";
    } else {
      // too few shared drops to check against: the one sensor that found a drip decides
      return single(only, only === sound ? "sound" : "picture", fusedInfo, durationMs, only === sound ? heard : seen, only === sound ? seen : heard, given);
    }
  } else if (anchorRate !== null) {
    rate = anchorRate;
    drops = confirmed.length + heardOnly + seenOnly;
    confidence = "medium";
  } else {
    reason = confirmed.length < 3 ? "too few drops were both seen and heard" : (quality.reason ?? "no steady drip found");
  }

  // a sensor's count can include a stray event or two; no more drops than the rate allows
  if (rate !== null) drops = Math.min(drops, Math.floor((rate * durationMs) / 60000) + 1);

  return {
    ...quality,
    events: seen.length + heard.length,
    drops,
    dropsPerMin: rate,
    intervalMs: rate !== null ? 60000 / rate : null,
    confidence: rate !== null ? confidence : "low",
    reason: rate !== null ? null : reason,
    fused: fusedInfo,
  };
}

const RANK = { high: 2, medium: 1, low: 0 } as const;

/** the sensor that found the clearer drip (the picture on a tie), or null if neither did */
function surer(sound: Measurement, picture: Measurement) {
  const s = rateOf(sound) !== null ? RANK[sound.confidence] : -1;
  const p = rateOf(picture) !== null ? RANK[picture.confidence] : -1;
  if (s < 0 && p < 0) return null;
  return p >= s ? picture : sound;
}

/**
 * one sensor's drip, as the combined answer. if the other sensor had nothing
 * to offer (a video without sound), it stands as it is. if the other sensor
 * was working but didn't find the same drip, it must be unmistakable on its
 * own, since a weak rhythm in one sensor is more often chance than a drip.
 */
function single(
  m: Measurement,
  which: "sound" | "picture",
  info: Fused["fused"],
  durationMs: number,
  events: number[],
  otherEvents: number[],
  given: Given,
): Fused {
  const other = which === "sound" ? info.picture : info.sound;
  const otherMissing = which === "sound" ? given.noPicture : given.noSound;
  const contradicted = rateOf(other) !== null;
  // the camera searches the whole picture, so seeing no drip anywhere counts against
  // one; a drip can land silently, so the mic only counts against it if it heard
  // other things instead
  const unconfirmed =
    !otherMissing && !contradicted && (which === "sound" || other.events >= 3) && !keepsTime(otherEvents, m.intervalMs!);
  if ((contradicted || unconfirmed) && !unmistakable(m, events)) {
    return {
      ...analyze("both", [], durationMs),
      events: info.sound.events + info.picture.events,
      confidence: "low",
      reason: contradicted
        ? "the sound and the picture found different drips, and neither is clear enough to trust: make sure the camera is on the tap you can hear"
        : `only the ${which} found a drip, and not clearly enough to be sure`,
      fused: { ...info, chose: which },
    };
  }
  return {
    ...m,
    // named after the sensor that found it when the other had nothing at all
    source: otherMissing ? (which === "sound" ? "mic" : "camera") : "both",
    durationMs,
    // the other sensor could have backed it up and didn't: less sure
    confidence: !otherMissing && m.confidence === "high" ? "medium" : m.confidence,
    reason: null,
    fused: { ...info, chose: which },
  };
}

/**
 * whether events keep time with a drip interval, even if they never line up
 * with the other sensor's (sound out of sync, or another take): most gaps
 * between them are a whole number of drips long
 */
export function keepsTime(events: number[], intervalMs: number) {
  const times = [...events].sort((a, b) => a - b);
  let fit = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    const k = Math.round(gap / intervalMs);
    if (k >= 1 && k <= 3 && Math.abs(gap - k * intervalMs) <= 0.2 * intervalMs) fit++;
  }
  return fit >= 4 && fit >= (times.length - 1) * KEEPS_TIME_SHARE;
}
/** share of gaps that must fit (randomly timed events fit about a third) */
const KEEPS_TIME_SHARE = 0.6;

/** a drip so clear on one sensor that it needs no backing from the other */
function unmistakable(m: Measurement, events: number[]) {
  if (m.confidence !== "high") return false;
  if (m.byRhythm) return true;
  const own = findRhythm(events, FLOOR_MS);
  return m.drops >= 6 && own.fitShare >= 0.75 && own.beatsPerGap <= 1.3;
}

/**
 * a stream judged by both sensors. a fast drip can look like a stream on
 * camera; if the sound clearly ticks to a drip rhythm, it is a drip.
 */
export function fuseStream(pictureStream: boolean, soundSteady: boolean, noSound = false, soundDrip = false) {
  if (pictureStream && soundDrip) return { stream: false, sure: false, note: "it looks like a stream, but it sounds like a fast drip" };
  if (pictureStream && soundSteady) return { stream: true, sure: true, note: "seen and heard as a steady stream" };
  if (pictureStream && noSound) return { stream: true, sure: true, note: "seen as a steady stream" };
  if (pictureStream) return { stream: true, sure: false, note: "it looks like a stream, but it doesn't sound like one" };
  return { stream: false, sure: !soundSteady, note: soundSteady ? "a steady rushing sound, but the camera sees drops or nothing" : "" };
}
