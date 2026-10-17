/**
 * combines what the camera saw with what the microphone heard.
 *
 * a drop is seen when it lets go of the tap and heard a moment later when it
 * lands, so the two sensors' events line up at a steady gap (plus a little
 * device delay). that gap is learned from the events themselves. a drop seen
 * and heard at that gap is confirmed; a drop caught by only one sensor still
 * counts if it lands on the confirmed rhythm. the two sensors' own drip rates
 * are also compared, so a mismatch (camera on the wrong tap, sound from
 * elsewhere) is reported instead of guessed through.
 */
import { analyze, type Measurement } from "@/lib/drips";
import { findRhythm } from "@/lib/rhythm";

/** the sound may come this long after (or, with device delay, slightly before) the sight */
const LAG_MIN_MS = -300;
const LAG_MAX_MS = 800;
const LAG_BIN_MS = 10;
/** a sound and a sighting this close to the learned gap are the same drop (two video frames) */
const PAIR_TOLERANCE_MS = 60;
/** the gap must be found in at least this many pairs... */
const MIN_PAIRS = 3;
/** ...covering at least this share of the sensor with fewer events */
const MIN_PAIR_SHARE = 0.3;
/** the two sensors' rates must agree this closely */
const RATE_AGREEMENT = 0.03;
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
  };
};

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

/** seen and heard event times (ms, same clock) over a measurement lasting durationMs */
export function fuse(seen: number[], heard: number[], durationMs: number): Fused {
  const sound = analyze("mic", heard, durationMs);
  const picture = analyze("camera", seen, durationMs);
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

  if (lagMs === null) {
    // the sensors never lined up: fall back to whichever one found a rhythm, honestly labelled
    const single = rates === "sound only" ? sound : rates === "picture only" ? picture : null;
    if (single) {
      return {
        ...single,
        source: "both",
        confidence: single.confidence === "high" ? "medium" : single.confidence,
        reason: null,
        fused: { ...base, confirmed: 0, heardOnly: rates === "sound only" ? single.drops : 0, seenOnly: rates === "picture only" ? single.drops : 0 },
      };
    }
    return {
      ...analyze("both", [], durationMs),
      events: seen.length + heard.length,
      confidence: "low",
      reason:
        rates === "disagree"
          ? "the sound and the picture don't match: make sure the camera is on the tap you can hear"
          : seen.length + heard.length
            ? "the sounds and movements never lined up as drops"
            : "no drops seen or heard",
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

  // every candidate on one timeline: a sighting and a sound of the same drop
  // become one event, then the rhythm keeps whatever lands on the beat
  type Candidate = { t: number; kind: "both" | "heard" | "seen" };
  const candidates: Candidate[] = [
    ...confirmed.map((t) => ({ t, kind: "both" as const })),
    ...seenSingles.map((t) => ({ t, kind: "seen" as const })),
  ];
  for (const t of heardSingles) {
    const same = candidates.find((c) => c.kind === "seen" && Math.abs(c.t - t) <= PAIR_TOLERANCE_MS * 2);
    if (same) same.kind = "both";
    else candidates.push({ t, kind: "heard" });
  }
  candidates.sort((a, b) => a.t - b.t);

  const rhythm = findRhythm(
    candidates.map((c) => c.t),
    FLOOR_MS,
  );
  const kinds = rhythm.matched.map((t) => candidates.find((c) => c.t === t)!.kind);
  const count = (k: Candidate["kind"]) => kinds.filter((x) => x === k).length;

  const result = analyze("both", rhythm.matched, durationMs);
  let confidence = result.confidence;
  let reason = result.reason;
  if (rates === "disagree") {
    confidence = "low";
    reason = "the sound and the picture keep different rhythms: make sure the camera is on the tap you can hear";
  } else if (count("both") < 4) {
    confidence = "low";
    reason = "too few drops were both seen and heard";
  } else if (rhythm.intervalMs !== null) {
    // the combined rhythm must match what each sensor found on its own
    for (const own of [soundRate, pictureRate]) {
      if (own !== null && Math.abs(60000 / rhythm.intervalMs - own) / own > RATE_AGREEMENT) {
        confidence = "low";
        reason = "the combined rhythm doesn't match what each sensor found on its own";
      }
    }
  }

  return {
    ...result,
    events: seen.length + heard.length,
    confidence,
    reason,
    fused: { ...base, confirmed: count("both"), heardOnly: count("heard"), seenOnly: count("seen") },
  };
}

/** a stream judged by both sensors */
export function fuseStream(pictureStream: boolean, soundSteady: boolean) {
  if (pictureStream && soundSteady) return { stream: true, sure: true, note: "seen and heard as a steady stream" };
  if (pictureStream) return { stream: true, sure: false, note: "it looks like a stream, but it doesn't sound like one" };
  return { stream: false, sure: !soundSteady, note: soundSteady ? "a steady rushing sound, but the camera sees drops or nothing" : "" };
}
