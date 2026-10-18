import { afterAll, describe, expect, it } from "vitest";
import { analyze, type Measurement } from "@/lib/drips";
import { fuse } from "@/lib/fusion";
import { gauss, rng } from "./synth";

/**
 * monte carlo check of the rhythm rules on realistic, imperfect drips:
 * timing that wobbles 3–20% from drop to drop, a rate that drifts over the
 * clip, missed drops and stray events on both sensors, in 10–30 s clips.
 * real videos often have sound that is out of sync, dubbed from another take,
 * or missing, so those are simulated too.
 */

type Clip = { truthRate: number | null; drops: number; heard: number[]; seen: number[]; durationMs: number };
/** how the sound relates to the picture */
type SoundKind = "synced" | "out of sync" | "another take" | "no sound";

function makeClip(r: () => number, withDrips: boolean, kind: SoundKind = "synced"): Clip {
  const durationSec = 10 + r() * 20;
  const interval = Math.exp(Math.log(0.3) + r() * (Math.log(4) - Math.log(0.3)));
  const jitter = 0.03 + r() * 0.17;
  const drift = r() * 0.15;
  // synced: heard as the drop lands; out of sync: the sound track is shifted by up to 3 s
  const lag = kind === "out of sync" ? (r() < 0.5 ? -1 : 1) * (300 + r() * 2700) : 120 + r() * 100;

  const truth: number[] = [];
  if (withDrips) {
    let t = 0.2 + r() * interval;
    while (t < durationSec - 0.2) {
      truth.push(t * 1000);
      const slope = 1 + drift * (t / durationSec - 0.5) * 2;
      t += Math.max(0.05, interval * slope * (1 + gauss(r) * jitter));
    }
  }

  const sensor = (miss: number, extrasPerSec: number, noiseMs: number, offsetMs: number) => {
    const out = truth.filter(() => r() >= miss).map((t) => t + offsetMs + gauss(r) * noiseMs);
    let t = 0;
    while (true) {
      t += (-Math.log(1 - r()) / Math.max(extrasPerSec, 1e-9)) * 1000;
      if (t >= durationSec * 1000) break;
      out.push(t);
    }
    return out.sort((a, b) => a - b);
  };

  let heard = sensor(r() * 0.3, withDrips ? r() * 0.8 : 0.2 + r() * 1.3, 3, lag);
  if (kind === "no sound") heard = [];
  if (kind === "another take" && withDrips) {
    // the same tap recorded separately: a few % faster or slower, its own wobble, no shared timing
    const rate = interval * (1 + (r() - 0.5) * 0.08);
    const take: number[] = [];
    for (let t = r() * rate; t < durationSec - 0.2; t += Math.max(0.05, rate * (1 + gauss(r) * jitter))) if (r() > 0.15) take.push(t * 1000);
    heard = take;
  }
  const seen = sensor(r() * 0.3, withDrips ? r() * 0.3 : r() * 0.5, 17, 0);
  const truthRate = truth.length > 1 ? (60000 * (truth.length - 1)) / (truth[truth.length - 1] - truth[0]) : null;
  return { truthRate, drops: truth.length, heard, seen, durationMs: durationSec * 1000 };
}

const usable = (m: Measurement) => m.dropsPerMin !== null && m.confidence !== "low";
const accurate = (m: Measurement, truth: number) => usable(m) && Math.abs(m.dropsPerMin! - truth) / truth <= 0.1;
/** half or double the rate, or further off: a real mistake, not just measurement wobble */
const badlyWrong = (m: Measurement, truth: number) => usable(m) && Math.abs(m.dropsPerMin! - truth) / truth > 0.25;

const N = 300;
const report: string[] = [];
afterAll(() => console.log(["", ...report].join("\n")));

describe("rhythm rules on realistic drips (simulation)", () => {
  const r = rng(20261017);
  const drips = Array.from({ length: N }, () => makeClip(r, true)).filter((c) => c.drops >= 4);
  const noise = Array.from({ length: N }, () => makeClip(r, false));

  const score = (pick: (c: Clip) => Measurement) => {
    let ok = 0;
    let unsure = 0;
    let wrong = 0;
    let bad = 0;
    for (const c of drips) {
      const m = pick(c);
      if (accurate(m, c.truthRate!)) ok++;
      else if (!usable(m)) unsure++;
      else wrong++;
      if (badlyWrong(m, c.truthRate!)) bad++;
    }
    const falseAlarms = noise.filter((c) => usable(pick(c))).length;
    return { ok: ok / drips.length, unsure: unsure / drips.length, wrong: wrong / drips.length, bad: bad / drips.length, falseAlarms: falseAlarms / noise.length };
  };
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);

  const results = {
    "sound alone": score((c) => analyze("mic", c.heard, c.durationMs)),
    "picture alone": score((c) => analyze("camera", c.seen, c.durationMs)),
    "camera + mic": score((c) => fuse(c.seen, c.heard, c.durationMs)),
  };
  // the same drips with the sound out of sync, from another take, or missing
  const variants = (["out of sync", "another take", "no sound"] as const).map((kind) => {
    const rv = rng(kind.length * 7919);
    const vDrips = Array.from({ length: N }, () => makeClip(rv, true, kind)).filter((c) => c.drops >= 4);
    const vNoise = Array.from({ length: N }, () => makeClip(rv, false, kind));
    const fused = (c: Clip) => fuse(c.seen, c.heard, c.durationMs, kind === "no sound" ? { noSound: true } : {});
    const ok = vDrips.filter((c) => accurate(fused(c), c.truthRate!)).length / vDrips.length;
    const unsure = vDrips.filter((c) => !usable(fused(c))).length / vDrips.length;
    const falseAlarms = vNoise.filter((c) => usable(fused(c))).length / vNoise.length;
    report.push(`camera + mic, ${kind.padEnd(13)} right rate (±10%) ${pct(ok)} · unsure ${pct(unsure)} · false alarms with no drip ${pct(falseAlarms)}`);
    return { kind, ok, unsure, falseAlarms };
  });
  for (const [name, s] of Object.entries(results)) {
    report.push(
      `${name.padEnd(14)} right rate (±10%) ${pct(s.ok)} · unsure ${pct(s.unsure)} · off by 10–25% ${pct(s.wrong - s.bad)} · badly wrong (>25%) ${pct(s.bad)} · false alarms with no drip ${pct(s.falseAlarms)}   (${drips.length} drip clips, ${noise.length} no-drip clips)`,
    );
  }

  // before loosening the rules (strict rhythm), camera + mic got only 20% right and was unsure 71% of the time
  it("camera + mic gets the rate right (within 10%) on at least 80% of realistic clips", () => {
    expect(results["camera + mic"].ok).toBeGreaterThanOrEqual(0.8);
  });
  it("camera + mic is unsure on under 15% of realistic clips", () => {
    expect(results["camera + mic"].unsure).toBeLessThan(0.15);
  });
  it("camera + mic is badly wrong (half, double or worse) on under 4% of clips", () => {
    expect(results["camera + mic"].bad).toBeLessThan(0.04);
  });
  it("camera + mic reports a drip that isn't there under 5% of the time", () => {
    expect(results["camera + mic"].falseAlarms).toBeLessThan(0.05);
  });
  for (const v of variants) {
    it(`sound ${v.kind}: still right on at least 75% of clips, with under 8% false alarms`, () => {
      expect(v.ok).toBeGreaterThanOrEqual(0.75);
      expect(v.falseAlarms).toBeLessThan(0.08);
    });
  }
});
