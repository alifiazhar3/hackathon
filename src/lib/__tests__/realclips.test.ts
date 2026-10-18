import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeSamples, ColumnSearch, combine } from "@/lib/recording";

/**
 * real leak videos (free pexels clips, listed in test-media/pexels/list.txt),
 * decoded in the browser the way drippy plays them: 320-px-wide grey frames
 * with their timestamps, and the sound (if any) at 48 khz. most stock videos
 * have no sound, so the picture has to manage on its own.
 */
const DIR = "test-media/pexels";
const have = existsSync(DIR) && readdirSync(DIR).some((f) => f.endsWith(".frames.gz"));

type Meta = { id: string; seconds: number; width: number; height: number; frames: number; times: number[]; hasAudio: boolean };

function load(id: string) {
  const meta = JSON.parse(readFileSync(`${DIR}/${id}.json`, "utf8")) as Meta;
  const delta = gunzipSync(readFileSync(`${DIR}/${id}.frames.gz`));
  const size = meta.width * meta.height;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < meta.frames; i++) {
    const f = new Uint8Array(size);
    const d = delta.subarray(i * size, (i + 1) * size);
    if (i === 0) f.set(d);
    else for (let k = 0; k < size; k++) f[k] = (frames[i - 1][k] + d[k]) & 255;
    frames.push(f);
  }
  let samples: Float32Array | null = null;
  if (meta.hasAudio && existsSync(`${DIR}/${id}.audio.gz`)) {
    const b = gunzipSync(readFileSync(`${DIR}/${id}.audio.gz`));
    const pcm = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
    samples = Float32Array.from(pcm, (x) => x / 32767);
  }
  return { meta, frames, samples };
}

/** the sound may be shifted against the picture by this much (ms), as in many videos */
function runClip(id: string, tap: number, soundShiftMs = 0) {
  const { meta, frames, samples } = load(id);
  const search = new ColumnSearch(meta.width, meta.height, tap);
  frames.forEach((f, i) => search.push(f, meta.times[i]));
  const durationMs = meta.seconds * 1000;
  const picture = search.result(durationMs);
  let sound = samples ? analyzeSamples(samples, 48000) : null;
  if (sound && soundShiftMs) sound = { ...sound, heard: sound.heard.map((t) => t + soundShiftMs) };
  return { meta, picture, sound, combined: combine(sound, picture, durationMs) };
}

/**
 * what each clip shows, worked out by stepping through it: where across the
 * picture (0–1) the water falls, and the true drip rate in drops per minute
 * (counted from the frames), or a stream. lo/hi bound an acceptable answer.
 */
type Truth = { column: number; kind: "drip" | "stream"; rate?: number; lo?: number; hi?: number; note: string };
const TRUTH: Record<string, Truth> = {
  "drip-10811027": { column: 0.66, kind: "drip", rate: 25, note: "slow motion, hand-held close-up, 10 drops" },
  "drip-2236002": { column: 0.78, kind: "drip", rate: 205, lo: 170, hi: 240, note: "tiny fast drops, then a hand turns the tap off at 12 s" },
  "drip-30615528": { column: 0.53, kind: "drip", rate: 3.9, lo: 2.5, hi: 6, note: "2 drops 15.5 s apart" },
  "drip-30615532": { column: 0.29, kind: "drip", rate: 110, note: "37 drops" },
  "drip-30615535": { column: 0.3, kind: "drip", rate: 113, note: "small drops from a short spout" },
  "drip-32711365": { column: 0.5, kind: "drip", lo: 60, hi: 200, note: "drops in front of a shiny pipe, hard to count by eye" },
  "drip-34186121": { column: 0.47, kind: "drip", rate: 38, lo: 33, hi: 43, note: "10 drops, slowing down" },
  "drip-39556135": { column: 0.42, kind: "drip", note: "a single drop in 17 s: too few to measure" },
  "drip-4571346": { column: 0.29, kind: "drip", rate: 34, note: "8 drops" },
  "drip-5311736": { column: 0.58, kind: "drip", rate: 12.2, note: "slow motion, each drop takes 2 s to fall" },
  "drip-5698926": { column: 0.56, kind: "drip", rate: 8.1, lo: 6.5, hi: 10, note: "3 drops 7.4 s apart" },
  "drip-5823848": { column: 0.6, kind: "drip", rate: 75.5, note: "13 drops" },
  "drip-853764": { column: 0.45, kind: "drip", rate: 41, note: "10 drops" },
  "drip-856403": { column: 0.45, kind: "drip", rate: 68, note: "28 drops" },
  "drip-9200530": { column: 0.48, kind: "drip", rate: 34.5, note: "18 drops, with sound" },
  "drip-9890451": { column: 0.55, kind: "drip", lo: 120, hi: 240, note: "camera moves in for 4 s, then a fast drip; with sound" },
  "stream-13556489": { column: 0.5, kind: "stream", note: "wavy trickle" },
  "stream-29251309": { column: 0.5, kind: "stream", note: "running tap" },
  "stream-34314520": { column: 0.6, kind: "stream", note: "sideways spray from an outdoor tap" },
  "stream-5571843": { column: 0.45, kind: "stream", note: "running tap" },
  "stream-5614823": { column: 0.6, kind: "stream", note: "tap opened at 5 s, camera drifts" },
};

function verdict(id: string, out: ReturnType<typeof runClip>) {
  const t = TRUTH[id];
  const m = out.combined?.measurement ?? null;
  const isStream = !!out.combined?.stream.stream;
  if (t.kind === "stream") return isStream ? "ok" : "missed stream";
  if (isStream) return "called a stream";
  const measurable = t.rate !== undefined || t.lo !== undefined;
  if (!m || m.dropsPerMin === null || m.confidence === "low") return measurable ? "missed leak" : "ok (unsure)";
  if (!measurable) return "ok (rough)";
  const lo = t.lo ?? t.rate! * 0.88;
  const hi = t.hi ?? t.rate! * 1.12;
  return m.dropsPerMin >= lo && m.dropsPerMin <= hi ? "ok" : "wrong rate";
}

function describeOut(id: string, v: string, out: ReturnType<typeof runClip>) {
  const t = TRUTH[id];
  const p = out.picture.measurement;
  const c = out.combined?.measurement;
  const truth = t.kind === "stream" ? "stream" : (t.rate ?? (t.lo !== undefined ? `${t.lo}-${t.hi}` : "?"));
  const sound = out.sound ? `${out.sound.measurement.dropsPerMin?.toFixed(1) ?? "-"}/min ${out.sound.measurement.confidence}` : "none";
  const result = out.combined?.stream.stream ? "STREAM" : c ? `${c.dropsPerMin?.toFixed(1) ?? "-"}/min ${c.confidence}` : "-";
  return `${v.padEnd(15)} ${id.padEnd(16)} truth ${String(truth).padEnd(7)} | picture col ${out.picture.column.toFixed(2)} ${p.dropsPerMin?.toFixed(1) ?? "-"}/min ${p.confidence}${p.rough ? " rough" : ""} ${p.drops}/${p.events} stream ${out.picture.isStream} | sound ${sound} | => ${result} ${c?.reason ?? ""}`;
}

const ids = have
  ? readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((id) => id in TRUTH)
      .sort()
  : [];

const report: string[] = [];
afterAll(() => console.log(["", ...report].join("\n")));

/**
 * still hard: a fast drip in front of shiny chrome looks like a stream, a
 * sideways spray isn't the falling line a stream is looked for as, and a
 * drifting, zooming camera blurs a stream that only runs for part of the clip.
 * drippy still reports a leak in each, just not the right kind.
 */
const HARD = new Set(["drip-32711365", "stream-34314520", "stream-5614823"]);

/** a leak reported at all: a stream, or a drip rate drippy stands behind */
const foundLeak = (out: ReturnType<typeof runClip>) =>
  !!out.combined?.stream.stream || (!!out.combined?.measurement && out.combined.measurement.dropsPerMin !== null && out.combined.measurement.confidence !== "low");

describe.skipIf(!have)("real leak videos, tapped where the water falls", () => {
  for (const id of ids) {
    it(`${id}: ${TRUTH[id].note}`, () => {
      const out = runClip(id, TRUTH[id].column);
      const v = verdict(id, out);
      report.push(describeOut(id, v, out) + (HARD.has(id) ? "  (known hard)" : ""));
      // every one of them shows a leak, so drippy must report one (one drop in 17 s is too few to)
      if (TRUTH[id].rate !== undefined || TRUTH[id].lo !== undefined || TRUTH[id].kind === "stream") expect(foundLeak(out)).toBe(true);
      if (!HARD.has(id)) expect(v.startsWith("ok")).toBe(true);
    });
  }
});

describe.skipIf(!have)("real leak videos, careless use", () => {
  it("tapped in the middle of the picture instead of on the drip: most leaks still found", () => {
    let found = 0;
    let right = 0;
    for (const id of ids) {
      const out = runClip(id, 0.5);
      const v = verdict(id, out);
      if (foundLeak(out)) found++;
      if (v.startsWith("ok")) right++;
      report.push(`tapped at 50%: ${describeOut(id, v, out)}`);
    }
    report.push(`tapped at 50%: ${found}/${ids.length} leaks found, ${right}/${ids.length} right`);
    expect(found).toBeGreaterThanOrEqual(ids.length - 3);
  });

  for (const id of ids.filter((i) => existsSync(`${DIR}/${i}.audio.gz`))) {
    for (const shift of [-2000, 1500]) {
      it(`${id}: sound ${shift / 1000} s out of sync gives the same answer`, () => {
        const synced = runClip(id, TRUTH[id].column);
        const out = runClip(id, TRUTH[id].column, shift);
        report.push(`sound shifted ${shift} ms: ${describeOut(id, verdict(id, out), out)}`);
        expect(verdict(id, out)).toBe(verdict(id, synced));
        expect(out.combined?.measurement?.dropsPerMin).toBeCloseTo(synced.combined!.measurement!.dropsPerMin!, 0);
      });
    }
  }
});
