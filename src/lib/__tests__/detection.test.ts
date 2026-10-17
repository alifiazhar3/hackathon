import { afterAll, describe, expect, it } from "vitest";
import { AudioDropDetector } from "@/lib/audioDrips";
import { VideoDropDetector } from "@/lib/videoDrips";
import { analyze, type Measurement } from "@/lib/drips";
import { addClatter, addDrips, addHiss, addMusic, addSpeech, renderVideo, rng, SR, VH, VW, type VideoScene } from "./synth";

const report: string[] = [];
afterAll(() => console.log(["", ...report].join("\n")));

function line(name: string, truth: number | null, m: Measurement) {
  const got = m.dropsPerMin === null ? "no rate" : `${m.dropsPerMin.toFixed(1)}/min`;
  const want = truth === null ? "no drips" : `${truth.toFixed(1)}/min`;
  const err = truth !== null && m.dropsPerMin !== null ? ` (${(((m.dropsPerMin - truth) / truth) * 100).toFixed(1)}%)` : "";
  report.push(`${name.padEnd(42)} truth ${want.padEnd(11)} got ${got}${err} · ${m.confidence} · ${m.drops}/${m.events} events`);
}

function runAudio(durSec: number, build: (buf: Float32Array, r: () => number) => number[], seed: number) {
  const r = rng(seed);
  const buf = new Float32Array(Math.floor(durSec * SR));
  const truth = build(buf, r);
  const det = new AudioDropDetector(SR);
  for (let i = 0; i < buf.length; i += 2048) det.process(buf.subarray(i, i + 2048));
  const m = analyze("mic", det.onsets.map((s) => s * 1000), durSec * 1000);
  const trueRate = truth.length > 1 ? (60 * (truth.length - 1)) / (truth[truth.length - 1] - truth[0]) : null;
  return { m, trueRate };
}

/** either right, or honestly unsure — never confidently wrong */
function expectHonest(m: Measurement, truth: number | null) {
  if (m.confidence === "low") return;
  expectAccurate(m, truth);
}

function expectAccurate(m: Measurement, truth: number | null) {
  expect(truth).not.toBeNull();
  expect(m.confidence).not.toBe("low");
  expect(m.dropsPerMin).not.toBeNull();
  expect(Math.abs(m.dropsPerMin! - truth!) / truth!).toBeLessThan(0.05);
}

describe("microphone", () => {
  const cases: [string, number, (b: Float32Array, r: () => number) => number[]][] = [
    ["quiet room, 1 drop/s", 32, (b, r) => (addHiss(b, 0.002, r), addDrips(b, 1, 0.2, r))],
    ["fan noise, 1 drop / 1.5 s", 32, (b, r) => (addHiss(b, 0.03, r), addDrips(b, 1.5, 0.2, r))],
    ["loud talking, 1 drop / 0.8 s", 32, (b, r) => (addSpeech(b, 0.1, r), addDrips(b, 0.8, 0.2, r))],
    ["music playing, 1 drop / 2 s", 40, (b, r) => (addMusic(b, 0.1, r), addDrips(b, 2, 0.2, r))],
    ["fast drip 4/s + fan", 32, (b, r) => (addHiss(b, 0.02, r), addDrips(b, 0.25, 0.2, r))],
    ["slow drip 1 / 6 s + talking", 70, (b, r) => (addSpeech(b, 0.08, r), addDrips(b, 6, 0.2, r))],
  ];
  // knocks that sound exactly like drips, at random times, can fool the sound
  // alone; drippy always measures with the camera too, which settles it (see
  // "loud talking and clatter" in fusion.test.ts). these just report the numbers.
  const soundAloneCanBeFooled: [string, number, (b: Float32Array, r: () => number) => number[]][] = [
    ["talking + clatter 1/s, 1 drop / 1.2 s", 32, (b, r) => (addSpeech(b, 0.08, r), addClatter(b, 1, 0.2, r), addDrips(b, 1.2, 0.2, r))],
    ["everything at once, 1 drop / s", 32, (b, r) => (addHiss(b, 0.02, r), addSpeech(b, 0.08, r), addMusic(b, 0.05, r), addClatter(b, 0.5, 0.2, r), addDrips(b, 1, 0.2, r))],
  ];
  for (const [name, dur, build] of soundAloneCanBeFooled) {
    it(`${name} (sound alone, report only)`, () => {
      const { m, trueRate } = runAudio(dur, build, name.length * 7919);
      line(`mic: ${name} (sound alone)`, trueRate, m);
    });
  }

  for (const [name, dur, build] of cases) {
    it(name, () => {
      const { m, trueRate } = runAudio(dur, build, name.length * 7919);
      line(`mic: ${name}`, trueRate, m);
      expectAccurate(m, trueRate);
    });
  }

  it("talking much louder than the drips", () => {
    const { m, trueRate } = runAudio(32, (b, r) => (addSpeech(b, 0.15, r), addDrips(b, 1.2, 0.1, r)), 4242);
    line("mic: talking much louder than the drips", trueRate, m);
    expectHonest(m, trueRate);
  });

  const noDrips: [string, (b: Float32Array, r: () => number) => number[]][] = [
    ["no drips, talking", (b, r) => (addSpeech(b, 0.1, r), [])],
    ["no drips, clatter 1/s", (b, r) => (addHiss(b, 0.01, r), addClatter(b, 1, 0.2, r), [])],
    ["no drips, music", (b, r) => (addMusic(b, 0.1, r), [])],
  ];
  for (const [name, build] of noDrips) {
    it(name, () => {
      const { m } = runAudio(32, build, name.length * 104729);
      line(`mic: ${name}`, null, m);
      expect(m.confidence).toBe("low");
    });
  }
});

describe("camera", () => {
  const base: VideoScene = {
    durationSec: 20,
    intervalSec: 1,
    column: 0.5,
    fallPx: 150,
    dropContrast: 45,
    sensorNoise: 3,
    flicker: 0,
    shake: 0,
    hand: false,
    insects: 0,
  };

  function runVideo(scene: VideoScene, seed: number, aimAt = scene.column) {
    const det = new VideoDropDetector(VW, VH, aimAt);
    let streamFrames = 0;
    let frames = 0;
    const truth = renderVideo(scene, seed, (gray, t) => {
      det.push(gray, t);
      frames++;
      if (det.status === "stream") streamFrames++;
    });
    const m = analyze("camera", det.onsets, scene.durationSec * 1000);
    const trueRate = truth.length > 1 ? (60000 * (truth.length - 1)) / (truth[truth.length - 1] - truth[0]) : null;
    return { m, trueRate, streamShare: streamFrames / frames };
  }

  const streams: [string, Partial<VideoScene>, boolean][] = [
    ["steady stream", { intervalSec: null, stream: true }, true],
    ["steady stream, noisy flickering camera", { intervalSec: null, stream: true, sensorNoise: 7, flicker: 6 }, true],
    ["steady stream, faint", { intervalSec: null, stream: true, dropContrast: 25 }, true],
    ["only a short stretch of stream in view", { intervalSec: null, stream: true, streamLength: 60 }, true],
    ["swaying stream", { intervalSec: null, stream: true, streamSway: 4 }, true],
    ["glassy stream that barely shimmers", { intervalSec: null, stream: true, streamShimmer: 0.2 }, true],
    ["thin, faint stream", { intervalSec: null, stream: true, dropContrast: 18, streamWidth: 1 }, true],
    ["faint stream, noisy flickering camera", { intervalSec: null, stream: true, dropContrast: 25, sensorNoise: 6, flicker: 5 }, true],
    ["drips are not a stream", {}, false],
    ["fast drips 3/s are not a stream", { intervalSec: 1 / 3 }, false],
    ["still pipe in view is not a stream", { intervalSec: null, pipe: true }, false],
    ["hand and bugs are not a stream", { intervalSec: null, hand: true, insects: 4 }, false],
  ];
  for (const [name, overrides, isStream] of streams) {
    it(name, () => {
      const { streamShare } = runVideo({ ...base, ...overrides }, name.length * 99991);
      report.push(`camera: ${name.padEnd(34)} stream seen in ${(streamShare * 100).toFixed(0)}% of frames`);
      if (isStream) expect(streamShare).toBeGreaterThan(0.5);
      else expect(streamShare).toBeLessThan(0.1);
    });
  }

  const cases: [string, Partial<VideoScene>][] = [
    ["clean view, 1 drop/s", {}],
    ["noisy dim camera", { sensorNoise: 7, dropContrast: 40 }],
    ["flickering lights / auto-brightness", { flicker: 6 }],
    ["shaky hand-held phone", { shake: 0.15 }],
    ["hand passing through", { hand: true }],
    ["bugs flying around", { insects: 4 }],
    ["fast drip 3/s", { intervalSec: 1 / 3 }],
    ["slow drip 1 / 4 s", { intervalSec: 4, durationSec: 45 }],
    ["short fall in view (60 px)", { fallPx: 60 }],
    ["drops off-centre, aimed correctly", { column: 0.27 }],
  ];
  for (const [name, overrides] of cases) {
    it(name, () => {
      const scene = { ...base, ...overrides };
      const { m, trueRate } = runVideo(scene, name.length * 31337);
      line(`camera: ${name}`, trueRate, m);
      expectAccurate(m, trueRate);
    });
  }

  const noDrips: [string, Partial<VideoScene>, number?][] = [
    ["no water: still scene", { intervalSec: null }],
    ["no water: noise + flicker + shake", { intervalSec: null, sensorNoise: 7, flicker: 6, shake: 0.15 }],
    ["no water: hand and bugs", { intervalSec: null, hand: true, insects: 4 }],
    ["aimed at the wrong spot", { column: 0.25 }, 0.7],
  ];
  for (const [name, overrides, aimAt] of noDrips) {
    it(name, () => {
      const scene = { ...base, ...overrides };
      const { m } = runVideo(scene, name.length * 7, aimAt);
      line(`camera: ${name}`, null, m);
      expect(m.dropsPerMin === null || m.confidence === "low").toBe(true);
    });
  }
});
