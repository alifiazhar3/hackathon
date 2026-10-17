import { afterAll, describe, expect, it } from "vitest";
import { AudioDropDetector } from "@/lib/audioDrips";
import { analyze, type Measurement } from "@/lib/drips";
import { fuse, fuseStream, type Fused } from "@/lib/fusion";
import { VideoDropDetector } from "@/lib/videoDrips";
import {
  addClatter,
  addDrips,
  addHiss,
  addPlinksAt,
  addSpeech,
  FALL_SEC,
  renderVideo,
  rng,
  SR,
  VH,
  VW,
  type VideoScene,
} from "./synth";

/**
 * synthetic scenes where the sound and the picture come from the same drips:
 * each drop is heard when it lands, FALL_SEC after it is seen, plus a little
 * device delay
 */
const DEVICE_DELAY_SEC = 0.03;
const DURATION = 20;

const report: string[] = [];
afterAll(() => console.log(["", ...report].join("\n")));

const BASE: VideoScene = {
  durationSec: DURATION,
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

type Scene = {
  video?: Partial<VideoScene>;
  noise?: (buf: Float32Array, r: () => number) => void;
  /** where the camera is aimed (defaults to where the drops fall) */
  aim?: number;
  plinkAmp?: number;
  /** "same": sounds from the seen drops; a number: an unrelated drip at that interval; "none": silent */
  sound?: "same" | number | "none";
};

function run(scene: Scene, seed: number) {
  const video = { ...BASE, ...scene.video };
  const seenDetector = new VideoDropDetector(VW, VH, scene.aim ?? video.column);
  let streamFrames = 0;
  let frames = 0;
  const truth = renderVideo(video, seed, (g, t) => {
    seenDetector.push(g, t);
    frames++;
    if (seenDetector.status === "stream") streamFrames++;
  });

  const r = rng(seed + 1);
  const buf = new Float32Array(DURATION * SR);
  scene.noise?.(buf, r);
  const sound = scene.sound ?? "same";
  if (sound === "same") addPlinksAt(buf, truth.map((t) => t / 1000 + FALL_SEC + DEVICE_DELAY_SEC), scene.plinkAmp ?? 0.2, r);
  else if (typeof sound === "number") addDrips(buf, sound, scene.plinkAmp ?? 0.2, r);
  const heardDetector = new AudioDropDetector(SR);
  for (let i = 0; i < buf.length; i += 2048) heardDetector.process(buf.subarray(i, i + 2048));
  const heard = heardDetector.onsets.map((s) => s * 1000);

  const fused = fuse(seenDetector.onsets, heard, DURATION * 1000);
  const trueRate = truth.length > 1 ? (60000 * (truth.length - 1)) / (truth[truth.length - 1] - truth[0]) : null;
  return {
    fused,
    trueRate,
    truthCount: truth.length,
    soundAlone: analyze("mic", heard, DURATION * 1000),
    pictureAlone: analyze("camera", seenDetector.onsets, DURATION * 1000),
    pictureStream: streamFrames / frames > 0.5,
    soundSteady: heardDetector.steadyHiss,
  };
}

function fmt(m: Measurement) {
  return m.dropsPerMin === null || m.confidence === "low" ? `unsure` : `${m.dropsPerMin.toFixed(1)} ${m.confidence}`;
}

function line(name: string, out: ReturnType<typeof run>) {
  const f = out.fused as Fused;
  report.push(
    `${name.padEnd(40)} truth ${out.trueRate?.toFixed(1) ?? "none"}/min (${out.truthCount}) | sound alone ${fmt(out.soundAlone).padEnd(12)} | picture alone ${fmt(out.pictureAlone).padEnd(12)} | combined ${fmt(f).padEnd(12)} ${f.drops} drops (${f.fused.confirmed} seen+heard, ${f.fused.heardOnly} heard only, ${f.fused.seenOnly} seen only) lag ${f.fused.lagMs?.toFixed(0) ?? "-"} ms, rates ${f.fused.rates}`,
  );
}

function expectAccurate(out: ReturnType<typeof run>, minShare = 0.9) {
  const f = out.fused;
  expect(f.confidence).not.toBe("low");
  expect(f.dropsPerMin).not.toBeNull();
  expect(Math.abs(f.dropsPerMin! - out.trueRate!) / out.trueRate!).toBeLessThan(0.03);
  expect(f.drops).toBeGreaterThanOrEqual(Math.floor(out.truthCount * minShare));
  expect(f.drops).toBeLessThanOrEqual(out.truthCount);
}

describe("camera + mic together", () => {
  // [name, scene, share of drops that must be individually counted]
  const accurate: [string, Scene, number?][] = [
    ["clean view, quiet room", { noise: (b, r) => addHiss(b, 0.002, r) }],
    ["loud talking and clatter", { noise: (b, r) => (addSpeech(b, 0.1, r), addClatter(b, 1, 0.2, r)) }],
    ["drips quieter than the talking", { noise: (b, r) => addSpeech(b, 0.15, r), plinkAmp: 0.1 }],
    ["dim, flickering camera with bugs", { video: { sensorNoise: 7, flicker: 6, insects: 4, dropContrast: 40 }, noise: (b, r) => addHiss(b, 0.002, r) }],
    // shaky frames are skipped while talking covers some sounds, so a few drops reach neither sensor;
    // the rhythm still gives the right rate
    ["messy room and messy camera", { video: { insects: 4, shake: 0.15 }, noise: (b, r) => (addSpeech(b, 0.08, r), addClatter(b, 0.7, 0.2, r)) }, 0.7],
    ["fast drip, 3 a second", { video: { intervalSec: 1 / 3 }, noise: (b, r) => addHiss(b, 0.01, r) }],
    ["slow drip, 1 every 3 s", { video: { intervalSec: 3, durationSec: DURATION }, noise: (b, r) => addSpeech(b, 0.06, r) }],
  ];
  for (const [name, scene, share] of accurate) {
    it(name, () => {
      const out = run(scene, name.length * 7717);
      line(name, out);
      expectAccurate(out, share);
      // most drops confirmed by both sensors
      // enough drops confirmed by both sensors to lock their timing together
      expect(out.fused.fused.confirmed).toBeGreaterThanOrEqual(4);
    });
  }

  it("camera aimed away: falls back to the sound, and says so", () => {
    const out = run({ aim: 0.85, noise: (b, r) => addHiss(b, 0.002, r) }, 991);
    line("camera aimed away", out);
    expect(out.fused.fused.rates).toBe("sound only");
    expect(out.fused.confidence).not.toBe("high");
    expect(Math.abs(out.fused.dropsPerMin! - out.trueRate!) / out.trueRate!).toBeLessThan(0.03);
  });

  it("sound from a different drip than the one on camera: reports the mismatch", () => {
    const out = run({ sound: 1.3, noise: (b, r) => addHiss(b, 0.002, r) }, 4242);
    line("sound and picture from different drips", out);
    expect(out.fused.confidence).toBe("low");
    expect(out.fused.reason).toMatch(/match|rhythm|lined up/);
  });

  it("no drips at all: talking, bugs and a hand", () => {
    const out = run({ video: { intervalSec: null, insects: 4, hand: true }, sound: "none", noise: (b, r) => (addSpeech(b, 0.1, r), addClatter(b, 1, 0.2, r)) }, 77);
    line("no drips: talking, bugs, a hand", out);
    expect(out.fused.confidence).toBe("low");
  });

  it("a stream seen and heard", () => {
    const out = run({ video: { intervalSec: null, stream: true }, sound: "none", noise: (b, r) => addHiss(b, 0.03, r) }, 5);
    report.push(`stream seen + heard: picture says stream ${out.pictureStream}, sound steady ${out.soundSteady}`);
    expect(fuseStream(out.pictureStream, out.soundSteady)).toMatchObject({ stream: true, sure: true });
  });

  it("looks like a stream but sounds like drips: not sure", () => {
    const out = run({ video: { intervalSec: null, stream: true }, sound: 0.8, noise: (b, r) => addHiss(b, 0.002, r) }, 6);
    report.push(`stream seen, drips heard: picture says stream ${out.pictureStream}, sound steady ${out.soundSteady}`);
    expect(fuseStream(out.pictureStream, out.soundSteady)).toMatchObject({ stream: true, sure: false });
  });
});
