import { describe, expect, it } from "vitest";
import { findPeriod, findPeriodAnywhere } from "@/lib/periodic";
import { isRepeat, Stabilizer, VideoDropDetector } from "@/lib/videoDrips";
import { gauss, rng } from "./synth";

/** a column's change over time: a slow swell, then a burst as each drop falls, plus noise */
function dripSignal(periodMs: number, seconds: number, seed: number, from = 0, to = seconds) {
  const r = rng(seed);
  const times: number[] = [];
  const values: number[] = [];
  for (let t = 0; t < seconds * 1000; t += 1000 / 30) {
    const phase = (t % periodMs) / periodMs;
    const dripping = t >= from * 1000 && t < to * 1000;
    const swell = dripping ? 20 * phase : 0;
    const burst = dripping && phase > 0.85 ? 300 : 0;
    times.push(t);
    values.push(Math.max(0, 15 + swell + burst + gauss(r) * 8));
  }
  return { times, values };
}

describe("finding a drip's rhythm in how a column changes", () => {
  for (const periodMs of [300, 900, 2400, 4800]) {
    it(`a drop every ${periodMs} ms`, () => {
      const { times, values } = dripSignal(periodMs, 25, periodMs);
      const p = findPeriod(times, values);
      expect(p.strength).toBeGreaterThan(0.5);
      expect(Math.abs(p.periodMs! - periodMs) / periodMs).toBeLessThan(0.05);
    });
  }

  it("noise alone has no clear rhythm", () => {
    const r = rng(7);
    const times = Array.from({ length: 750 }, (_, i) => (i * 1000) / 30);
    const values = times.map(() => Math.max(0, 20 + gauss(r) * 10));
    expect(findPeriod(times, values).strength).toBeLessThan(0.3);
  });

  it("a drip that stops partway (a hand turns the tap off) is still found", () => {
    const { times, values } = dripSignal(300, 28, 3, 0, 11);
    const p = findPeriodAnywhere(times, values);
    expect(p.strength).toBeGreaterThan(0.5);
    expect(Math.abs(p.periodMs! - 300) / 300).toBeLessThan(0.05);
  });
});

describe("steadying a moving picture", () => {
  const W = 120;
  const H = 80;
  const scene = (dx: number, dy: number) => {
    const f = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = ((Math.floor((x + dx) / 9) + Math.floor((y + dy) / 7)) % 2) * 120 + 60;
    return f;
  };

  it("moves each frame back to where the scene started", () => {
    const steady = new Stabilizer(W, H);
    steady.push(scene(0, 0));
    let out = scene(0, 0);
    for (let i = 1; i <= 5; i++) out = steady.push(scene(i * 2, i)); // drifting right and down
    // away from the filled-in edges, the steadied frame matches the first one
    let differ = 0;
    const first = scene(0, 0);
    for (let y = 10; y < H - 10; y++) for (let x = 15; x < W - 15; x++) if (out[y * W + x] !== first[y * W + x]) differ++;
    expect(differ).toBe(0);
  });

  it("leaves a still picture alone", () => {
    const steady = new Stabilizer(W, H);
    const f = scene(0, 0);
    steady.push(f);
    expect(steady.push(f)).toBe(f);
  });
});

describe("repeated frames (slow motion, frame-rate conversion)", () => {
  it("a copy is a repeat; a frame with one small drop isn't", () => {
    const a = new Uint8Array(320 * 180).fill(100);
    const b = Uint8Array.from(a);
    expect(isRepeat(a, b)).toBe(true);
    for (const i of [5000, 5002, 5004, 5320, 5322]) b[i] = 160;
    expect(isRepeat(a, b)).toBe(false);
  });

  it("every drop is still counted once when each frame is shown twice", () => {
    const W = 160;
    const H = 90;
    const r = rng(11);
    const detector = new VideoDropDetector(W, H, 0.5);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      const f = new Uint8Array(W * H);
      for (let k = 0; k < f.length; k++) f[k] = 100 + gauss(r) * 2;
      // a drop every 30 frames, each frame shown twice
      if (i % 30 < 3) for (let y = 30 + (i % 30) * 15; y < 40 + (i % 30) * 15; y++) for (let x = 78; x < 82; x++) f[y * W + x] = 220;
      detector.push(f, t);
      t += 1000 / 60;
      detector.push(Uint8Array.from(f), t);
      t += 1000 / 60;
    }
    expect(detector.onsets.length).toBeGreaterThanOrEqual(8);
    expect(detector.onsets.length).toBeLessThanOrEqual(10);
  });
});
