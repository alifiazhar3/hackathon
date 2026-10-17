import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { AudioDropDetector } from "@/lib/audioDrips";
import { analyze } from "@/lib/drips";
import { VideoDropDetector } from "@/lib/videoDrips";

/**
 * a real 11.6 s recording of a dripping tap (test-media/water-dripping-sound-effect.mp4),
 * decoded in the browser to 16 khz sound and 320 × 180 grey frames at 30 fps.
 * the true drop times below were logged by stepping through it frame by frame.
 * the sound and picture come from different takes, so their drops differ.
 */
const DIR = "test-media";
const AUDIO = `${DIR}/clip-audio-16k.i16.gz`;
const FRAMES = `${DIR}/clip-frames-320x180.delta.gz`;
const W = 320;
const H = 180;
const FPS = 30;

/** sound: 20 plinks, one every ~0.555 s */
const SOUND_DROPS = [0.496, 1.051, 1.6, 2.17, 2.711, 3.26, 3.816, 4.37, 4.92, 5.46, 6.01, 6.56, 7.119, 7.67, 8.23, 8.78, 9.34, 9.89, 10.44, 11.0];
/** picture: 20 drops, one every ~0.6 s (the video loops once at 5.77 s) */
const PICTURE_DROPS = [0.07, 0.63, 1.23, 1.83, 2.43, 3.0, 3.6, 4.2, 4.8, 5.37, 5.77, 6.33, 6.93, 7.53, 8.13, 8.73, 9.33, 9.93, 10.5, 11.1];

const haveClip = existsSync(AUDIO) && existsSync(FRAMES);

function matchCount(found: number[], truth: number[], slack: number) {
  const hits = truth.filter((t) => found.some((f) => Math.abs(f - t) < slack)).length;
  const extras = found.filter((f) => !truth.some((t) => Math.abs(f - t) < slack)).length;
  return { hits, extras };
}

describe.skipIf(!haveClip)("real dripping-tap recording", () => {
  it("the microphone hears every drop, and nothing else", () => {
    const bytes = gunzipSync(readFileSync(AUDIO));
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const samples = Float32Array.from(pcm, (x) => x / 32767);
    const detector = new AudioDropDetector(16000);
    for (let i = 0; i < samples.length; i += 2048) detector.process(samples.subarray(i, i + 2048));

    const { hits, extras } = matchCount(detector.onsets, SOUND_DROPS, 0.03);
    expect(hits).toBe(20);
    expect(extras).toBe(0);

    const m = analyze("mic", detector.onsets.map((s) => s * 1000), (samples.length / 16000) * 1000);
    expect(m.drops).toBe(20);
    expect(m.confidence).toBe("high");
    expect(m.dropsPerMin!).toBeCloseTo(60 / 0.5528, 0);
  });

  const delta = haveClip ? gunzipSync(readFileSync(FRAMES)) : new Uint8Array();
  const frames: Uint8Array[] = [];
  for (let i = 0; i * W * H < delta.length; i++) {
    const f = new Uint8Array(W * H);
    for (let k = 0; k < f.length; k++) f[k] = i === 0 ? delta[k] : (frames[i - 1][k] + delta[i * W * H + k]) & 255;
    frames.push(f);
  }

  // drops fall at ~45% across; a tap within about 5% of the picture width of it works
  for (const aim of [0.4, 0.42, 0.45, 0.48, 0.52]) {
    it(`the camera sees every drop when tapped at ${Math.round(aim * 100)}% across`, () => {
      const detector = new VideoDropDetector(W, H, aim);
      frames.forEach((f, i) => detector.push(f, (i * 1000) / FPS));

      const found = detector.onsets.map((t) => t / 1000);
      const { hits } = matchCount(found, PICTURE_DROPS, 0.12);
      expect(hits).toBe(20);

      const m = analyze("camera", detector.onsets, (frames.length * 1000) / FPS);
      expect(m.drops).toBe(20);
      expect(m.confidence).toBe("high");
      expect(Math.abs(m.dropsPerMin! - 101) / 101).toBeLessThan(0.02);
    });
  }

  it("the camera sees nothing when tapped away from the drops", () => {
    const detector = new VideoDropDetector(W, H, 0.85);
    frames.forEach((f, i) => detector.push(f, (i * 1000) / FPS));
    expect(analyze("camera", detector.onsets, (frames.length * 1000) / FPS).drops).toBeLessThanOrEqual(2);
  });
});
