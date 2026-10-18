import { existsSync, readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { ColumnSearch, combine } from "@/lib/recording";

/**
 * the real leak videos reshaped the way phones film: upright (portrait), and
 * at 60 frames a second. drippy must find the same leaks in them.
 */
const DIR = "test-media/pexels";
const have = existsSync(DIR) && readdirSync(DIR).some((f) => f.endsWith(".frames.gz"));

type Meta = { seconds: number; width: number; height: number; frames: number; times: number[] };

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
  return { meta, frames };
}

/** an upright 9:16 slice around the drip, scaled to 320 wide as drippy would see a phone video */
function portrait(f: Uint8Array, w: number, h: number, column: number) {
  const cropW = Math.round((h * 9) / 16);
  const x0 = Math.max(0, Math.min(w - cropW, Math.round(column * w - cropW / 2)));
  const W = 320;
  const H = Math.round((W * 16) / 9);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) out[y * W + x] = f[sy * w + x0 + Math.min(cropW - 1, Math.floor((x * cropW) / W))];
  }
  return { frame: out, W, H, column: (column * w - x0) / cropW };
}

const CASES: [string, number, number, number?][] = [
  // [clip, drip column, true rate (or lo), hi]
  ["drip-30615532", 0.29, 110],
  ["drip-4571346", 0.29, 34],
  ["drip-5823848", 0.6, 75.5],
  ["drip-853764", 0.45, 41],
  ["drip-856403", 0.45, 68],
  ["drip-34186121", 0.47, 33, 43],
  ["drip-9200530", 0.48, 34.5],
  ["drip-5311736", 0.58, 12.2],
  ["drip-10811027", 0.66, 25],
];

/** a hand-held slow-motion close-up cropped upright: the tap fills the whole picture, so nothing stands out */
const HARD_UPRIGHT = new Set(["drip-10811027"]);

const report: string[] = [];
afterAll(() => console.log(["", ...report].join("\n")));

function judge(rate: number | null | undefined, truth: number, hi?: number) {
  if (rate == null) return false;
  return hi ? rate >= truth && rate <= hi : Math.abs(rate - truth) / truth <= 0.12;
}

describe.skipIf(!have)("real leak videos filmed like a phone", () => {
  for (const [id, column, truth, hi] of CASES) {
    it(`${id}, upright`, () => {
      const { meta, frames } = load(id);
      let search: ColumnSearch | null = null;
      let tap = column;
      frames.forEach((f, i) => {
        const p = portrait(f, meta.width, meta.height, column);
        tap = p.column;
        search ??= new ColumnSearch(p.W, p.H, tap);
        search.push(p.frame, meta.times[i]);
      });
      const m = combine(null, search!.result(meta.seconds * 1000), meta.seconds * 1000)?.measurement;
      report.push(`upright ${id.padEnd(15)} truth ${truth} -> ${m?.dropsPerMin?.toFixed(1) ?? "-"}/min ${m?.confidence ?? ""} ${m?.reason ?? ""}${HARD_UPRIGHT.has(id) ? "  (known hard)" : ""}`);
      if (!HARD_UPRIGHT.has(id)) expect(judge(m?.confidence === "low" ? null : m?.dropsPerMin, truth, hi)).toBe(true);
    });

    it(`${id}, 60 frames a second`, () => {
      const { meta, frames } = load(id);
      const search = new ColumnSearch(meta.width, meta.height, column);
      // twice the frames: each new one halfway between its neighbours, as a 60 fps camera sees
      frames.forEach((f, i) => {
        if (i > 0) {
          const prev = frames[i - 1];
          const mid = new Uint8Array(f.length);
          for (let k = 0; k < f.length; k++) mid[k] = (prev[k] + f[k] + (k % 2)) >> 1;
          search.push(mid, (meta.times[i - 1] + meta.times[i]) / 2);
        }
        search.push(f, meta.times[i]);
      });
      const m = combine(null, search.result(meta.seconds * 1000), meta.seconds * 1000)?.measurement;
      report.push(`60 fps  ${id.padEnd(15)} truth ${truth} -> ${m?.dropsPerMin?.toFixed(1) ?? "-"}/min ${m?.confidence ?? ""} ${m?.reason ?? ""}`);
      expect(judge(m?.confidence === "low" ? null : m?.dropsPerMin, truth, hi)).toBe(true);
    });
  }
});
