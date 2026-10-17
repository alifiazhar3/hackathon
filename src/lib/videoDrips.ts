/**
 * finds falling drops in camera frames.
 *
 * it only watches a narrow column where the user said drops fall. a drop is
 * counted only when a small object moves down that column over several
 * frames and speeds up as it goes (gravity). changes across the whole picture
 * (flicker, auto-brightness, a shaking hand) are ignored, so the count stays
 * at zero unless something is actually dripping.
 *
 * it also recognises a steady stream: a long, thin, unbroken line down the
 * column that keeps shimmering frame after frame. a still object in the same
 * place (a pipe, a shadow) doesn't shimmer, so it isn't mistaken for one.
 */

/** time spent learning the camera's own noise before counting */
export const CAMERA_CALIBRATE_MS = 1000;
/** half-width of the watched column, as a fraction of the frame width */
export const COLUMN_HALF_WIDTH = 0.08;

/** a frame is ignored if this share of the picture changed at once */
const GLOBAL_CHANGE_LIMIT = 0.12;
const GLOBAL_PIXEL_DIFF = 25;
/** smallest (smoothed) pixel change that can be part of a drop */
const MIN_DIFF = 10;
const MIN_BLOB_AREA = 2;
/** a frame with more changing blobs than this in the column is clutter */
const MAX_BLOBS = 6;
/** tracks end when not seen for this long */
const TRACK_TIMEOUT_MS = 160;
/** a drop must be seen at least this many times... */
const MIN_POINTS = 3;
/** ...falling at least this share of the frame height */
const MIN_FALL = 0.06;
/** ...staying this close to a vertical line (px) */
const MAX_DRIFT = 8;
/** later speed must be at least this share of earlier speed (it accelerates) */
const MIN_SPEEDUP = 0.9;
/**
 * ...and by the end it must be moving at least this share of the frame height
 * per 100 ms. a drop swelling at the spout sags downward too, but far slower.
 */
const MIN_FALL_SPEED = 0.12;
/**
 * tested on a real recording, following falling objects added false drops
 * (a swelling drop sags like a slow fall) and the sudden-change check alone
 * caught every drop, so tracking no longer counts drops on its own
 */
const TRACKER_COUNTS = false;
/**
 * many drops cross the picture in a single frame (seen as a streak) or simply
 * vanish from the spout between frames. a sudden, compact change in the column
 * counts as a drop: at least this many changed pixels per row of the picture...
 */
const SUDDEN_MIN_PIXELS_PER_ROW = 0.15;
/** ...and well above the column's usual frame-to-frame change */
const SUDDEN_OVER_USUAL = 5;
/** ...but not so much that it's a hand or something big passing */
const SUDDEN_MAX_SHARE = 0.25;
/** a drop changes almost nothing outside the column; shake or a passing hand changes more than this share of the picture */
const SUDDEN_MAX_GLOBAL = 0.02;
/** a drop or its streak is narrow: changes spanning more of the column than this are something else */
const SUDDEN_MAX_WIDTH = 0.45;
/** changes this close together are the same drop (forming, falling, splashing) */
const SAME_DROP_MS = 250;
const USUAL_WINDOW = 60;

/** a stream must cover this share of the frame height in one unbroken run */
const STREAM_MIN_LENGTH = 0.15;
/** ...stay this close to a straight vertical line (px) */
const STREAM_MAX_WOBBLE = 8;
/** ...and show up in this share of recent frames */
const STREAM_MIN_SHARE = 0.5;
/** a shimmering stream has gaps in any one frame, so combine this many */
const STREAM_MEMORY_FRAMES = 4;
/** the straight-line test rejects random noise, so a stream can use a lower change threshold */
const STREAM_THRESHOLD_SHARE = 0.4;
/** rows along a stream's line must be at least this full... */
const STREAM_MIN_DENSITY = 0.6;
/** a row must be on the line in at least this share of the last STREAM_PERSIST_FRAMES frames */
const STREAM_MIN_PERSIST = 0.5;
const STREAM_PERSIST_FRAMES = 10;
/** ...and this much fuller than grain alone would make them */
const STREAM_OVER_GRAIN_DENSITY = 0.35;
const STREAM_WINDOW = 30;

type Blob = { x: number; y: number; area: number };
type Point = { t: number; x: number; y: number };
type Track = { points: Point[]; counted: boolean };

export type CameraStatus = "calibrating" | "watching" | "unsteady" | "stream";

export class VideoDropDetector {
  private frames: { gray: Uint8Array; t: number; mean: number }[] = [];
  private noiseSamples: number[] = [];
  private threshold = MIN_DIFF;
  /** the camera's own frame-to-frame grain, learned at the start */
  private sigma = MIN_DIFF / 5;
  private tracks: Track[] = [];
  private startedAt: number | null = null;
  private x0: number;
  private x1: number;
  private streamFrames: boolean[] = [];
  /** which rows were on the stream line in recent frames */
  private lineHistory: Uint8Array[] = [];
  /** frame number when each column pixel last changed */
  private lastChanged: Int32Array | null = null;
  private frameNo = 0;

  /** drop times in ms, using the timestamps passed to push() */
  readonly onsets: number[] = [];
  /** changed pixels in the column on the latest frame (for display) */
  level = 0;
  status: CameraStatus = "calibrating";

  constructor(
    private width: number,
    private height: number,
    columnFraction: number,
  ) {
    const half = Math.max(4, Math.round(width * COLUMN_HALF_WIDTH));
    const cx = Math.round(columnFraction * width);
    this.x0 = Math.max(0, cx - half);
    this.x1 = Math.min(width, cx + half);
  }

  /** feed one grayscale frame (width × height, row by row) taken at time t (ms) */
  push(gray: Uint8Array, t: number) {
    if (this.startedAt === null) this.startedAt = t;
    this.frames.push({ gray, t, mean: this.columnMean(gray) });
    if (this.frames.length > 3) this.frames.shift();
    if (this.frames.length < 3) return;

    const [f0, f1, f2] = this.frames;

    const global = this.globalChange(f1, f2);
    if (global > GLOBAL_CHANGE_LIMIT) {
      // the whole picture moved or changed brightness: nothing here is a drop
      this.status = "unsteady";
      this.tracks = [];
      this.level = 0;
      return;
    }

    if (t - this.startedAt < CAMERA_CALIBRATE_MS) {
      this.status = "calibrating";
      this.sampleNoise(f1, f2);
      if (!this.calibrationFrames.length) this.calibrationFrames.push(f1);
      this.calibrationFrames.push(f2);
      return;
    }
    if (this.noiseSamples.length) {
      const sorted = [...this.noiseSamples].sort((a, b) => a - b);
      const sigma = sorted[Math.floor(sorted.length / 2)] * 1.4826;
      this.sigma = sigma;
      this.threshold = Math.max(MIN_DIFF, sigma * 5);
      this.noiseSamples = [];
      // now that the camera's noise is known, look for drops in the first second too
      const cf = this.calibrationFrames;
      const counts = cf.slice(1).map((b, i) => this.countChange(cf[i], b));
      this.usual = counts.slice(-USUAL_WINDOW).map((c) => c.changed);
      counts.forEach((c, i) => this.judgeChange(c, this.globalChange(cf[i], cf[i + 1]), cf[i + 1].t));
      this.calibrationFrames = [];
    }
    this.checkSuddenChange(f1, f2, global);
    const blobs = this.findBlobs(f0, f1, f2);
    this.status = this.stream ? "stream" : "watching";
    if (blobs === null) {
      this.tracks = [];
      return;
    }
    this.track(blobs, f1.t);
  }

  /** whether a steady stream has been seen in most recent frames */
  get stream() {
    if (this.streamFrames.length < STREAM_WINDOW / 2) return false;
    return this.streamFrames.filter(Boolean).length / this.streamFrames.length >= STREAM_MIN_SHARE;
  }

  /**
   * a long, thin run of shimmering pixels down one line of the column. the
   * line is where activity piles up; a row counts if it has activity within
   * a sway's width of that line. camera grain lands there too, so the rows on
   * the line must be far denser than grain alone would make them.
   */
  private looksLikeStream(mask: Uint8Array, w: number, h: number) {
    // the line: the x where activity piles up most (smoothed over a few pixels)
    const perX = new Float64Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) perX[x]++;
    let line = 0;
    let lineScore = -1;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let d = -2; d <= 2; d++) sum += perX[x + d] ?? 0;
      if (sum > lineScore) {
        lineScore = sum;
        line = x;
      }
    }
    const lo = Math.max(0, line - STREAM_MAX_WOBBLE);
    const hi = Math.min(w - 1, line + STREAM_MAX_WOBBLE);
    const band = hi - lo + 1;

    // how often grain alone would put a pixel in the band, from activity outside it
    let outside = 0;
    for (let x = 0; x < w; x++) if (x < lo || x > hi) outside += perX[x];
    const grainPerPixel = outside / Math.max(1, h * (w - band));
    const grainChance = 1 - (1 - grainPerPixel) ** band;

    // a stream's line is busy frame after frame; a falling drop crosses each
    // spot only briefly. so a row counts only if it was on the line in at least
    // half of the recent frames (and more often than grain would put it there)
    const hits = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = lo; x <= hi; x++) {
        if (mask[y * w + x]) {
          hits[y] = 1;
          break;
        }
      }
    }
    this.lineHistory.push(hits);
    if (this.lineHistory.length > STREAM_PERSIST_FRAMES) this.lineHistory.shift();
    const persistNeeded = Math.max(STREAM_MIN_PERSIST, grainChance + 0.3);
    const onLine: boolean[] = [];
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (const past of this.lineHistory) n += past[y] ?? 0;
      onLine.push(n / this.lineHistory.length >= persistNeeded);
    }
    let bestLength = 0;
    let bestDensity = 0;
    let runStart = -1;
    let runHits = 0;
    let gap = 0;
    for (let y = 0; y <= h; y++) {
      const hit = y < h && onLine[y];
      if (hit) {
        if (runStart < 0) runStart = y;
        runHits++;
        gap = 0;
      } else if (runStart >= 0 && gap < 3 && y < h) {
        gap++;
      } else if (runStart >= 0) {
        const length = y - gap - runStart;
        if (length > bestLength) {
          bestLength = length;
          bestDensity = runHits / length;
        }
        runStart = -1;
        runHits = 0;
        gap = 0;
      }
    }
    return bestLength >= h * STREAM_MIN_LENGTH && bestDensity >= Math.max(STREAM_MIN_DENSITY, grainChance + STREAM_OVER_GRAIN_DENSITY);
  }

  /** average of a 2 × 2 block, which halves the camera's pixel noise */
  private px(gray: Uint8Array, i: number) {
    return (gray[i] + gray[i + 1] + gray[i + this.width] + gray[i + this.width + 1]) / 4;
  }

  private columnMean(gray: Uint8Array) {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < this.height; y += 2) {
      for (let x = this.x0; x < this.x1; x += 2) {
        sum += gray[y * this.width + x];
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  /** share of a coarse grid over the whole frame that changed, after brightness correction */
  private globalChange(a: { gray: Uint8Array }, b: { gray: Uint8Array }) {
    let meanDiff = 0;
    let n = 0;
    for (let y = 0; y < this.height; y += 4) {
      for (let x = 0; x < this.width; x += 4) {
        const i = y * this.width + x;
        meanDiff += b.gray[i] - a.gray[i];
        n++;
      }
    }
    meanDiff /= n;
    let changed = 0;
    for (let y = 0; y < this.height; y += 4) {
      for (let x = 0; x < this.width; x += 4) {
        const i = y * this.width + x;
        if (Math.abs(b.gray[i] - a.gray[i] - meanDiff) > GLOBAL_PIXEL_DIFF) changed++;
      }
    }
    return changed / n;
  }

  private sampleNoise(a: { gray: Uint8Array; mean: number }, b: { gray: Uint8Array; mean: number }) {
    const shift = b.mean - a.mean;
    for (let y = 0; y < this.height - 1; y += 3) {
      for (let x = this.x0; x < this.x1 - 1; x += 3) {
        const i = y * this.width + x;
        this.noiseSamples.push(Math.abs(this.px(b.gray, i) - this.px(a.gray, i) - shift));
      }
    }
  }

  /** small changing spots in the column on the middle frame (three-frame difference) */
  private findBlobs(
    f0: { gray: Uint8Array; mean: number },
    f1: { gray: Uint8Array; mean: number },
    f2: { gray: Uint8Array; mean: number },
  ): Blob[] | null {
    const w = this.x1 - this.x0;
    const h = this.height;
    const mask = new Uint8Array(w * h);
    const streamMask = new Uint8Array(w * h);
    const streamThreshold = this.threshold * STREAM_THRESHOLD_SHARE;
    const s01 = f1.mean - f0.mean;
    const s21 = f1.mean - f2.mean;
    let changed = 0;
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = y * this.width + x + this.x0;
        const v1 = this.px(f1.gray, i);
        const d1 = Math.abs(v1 - this.px(f0.gray, i) - s01);
        const d2 = Math.abs(v1 - this.px(f2.gray, i) - s21);
        if (d1 > streamThreshold && d2 > streamThreshold) streamMask[y * w + x] = 1;
        if (d1 > this.threshold && d2 > this.threshold) {
          mask[y * w + x] = 1;
          changed++;
        }
      }
    }
    this.level = changed;
    this.frameNo++;
    if (!this.lastChanged) this.lastChanged = new Int32Array(w * h).fill(-1000);
    const recent = new Uint8Array(w * h);
    for (let i = 0; i < streamMask.length; i++) {
      if (streamMask[i]) this.lastChanged[i] = this.frameNo;
      if (this.frameNo - this.lastChanged[i] < STREAM_MEMORY_FRAMES) recent[i] = 1;
    }
    this.streamFrames.push(this.looksLikeStream(recent, w, h));
    if (this.streamFrames.length > STREAM_WINDOW) this.streamFrames.shift();
    if (changed > w * h * 0.15) return null;

    const maxArea = Math.max(12, w * h * 0.02);
    const maxHeight = h * 0.25;
    const blobs: Blob[] = [];
    const stack: number[] = [];
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      mask[start] = 2;
      stack.push(start);
      let area = 0;
      let sx = 0;
      let sy = 0;
      let minX = w;
      let maxX = 0;
      let minY = h;
      let maxY = 0;
      while (stack.length) {
        const p = stack.pop()!;
        const x = p % w;
        const y = (p - x) / w;
        area++;
        sx += x;
        sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (const q of [p - 1, p + 1, p - w, p + w]) {
          if (q < 0 || q >= mask.length || mask[q] !== 1) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
          mask[q] = 2;
          stack.push(q);
        }
      }
      const tall = maxY - minY + 1;
      const wide = maxX - minX + 1;
      if (area >= MIN_BLOB_AREA && area <= maxArea && tall <= maxHeight && wide <= w * 0.8) {
        blobs.push({ x: sx / area + this.x0, y: sy / area, area });
      }
    }
    return blobs.length > MAX_BLOBS ? null : blobs;
  }

  /** recent frame-to-frame change in the column, to know what "usual" looks like */
  private usual: number[] = [];
  private calibrationFrames: { gray: Uint8Array; t: number; mean: number }[] = [];

  /** pixels in the column that changed between two frames, after brightness correction */
  /** pixels in the column that changed between two frames (after brightness correction), and how wide the change is */
  private countChange(a: { gray: Uint8Array; mean: number }, b: { gray: Uint8Array; mean: number }) {
    const shift = b.mean - a.mean;
    let changed = 0;
    const perX = new Int32Array(this.x1 - this.x0);
    for (let y = 0; y < this.height - 1; y++) {
      for (let x = this.x0; x < this.x1 - 1; x++) {
        const i = y * this.width + x;
        if (Math.abs(this.px(b.gray, i) - this.px(a.gray, i) - shift) > this.threshold) {
          changed++;
          perX[x - this.x0]++;
        }
      }
    }
    // width = columns holding most of the change (ignore stray noisy pixels)
    let width = 0;
    for (const n of perX) if (n >= Math.max(2, changed * 0.02)) width++;
    return { changed, width };
  }

  private judgeChange({ changed, width }: { changed: number; width: number }, global: number, t: number) {
    // "usual" comes from the quieter frames, so frequent drops don't raise it
    const sorted = [...this.usual].sort((p, q) => p - q);
    const usual = sorted.length ? sorted[Math.floor(sorted.length * 0.3)] : changed;
    const area = (this.height - 1) * (this.x1 - this.x0 - 1);
    const narrow = width <= (this.x1 - this.x0) * SUDDEN_MAX_WIDTH;
    const big = changed >= this.height * SUDDEN_MIN_PIXELS_PER_ROW && changed >= usual * SUDDEN_OVER_USUAL;
    if (!this.stream && narrow && big && global <= SUDDEN_MAX_GLOBAL && changed <= area * SUDDEN_MAX_SHARE) {
      this.addOnset(t);
    }
  }

  private checkSuddenChange(a: { gray: Uint8Array; mean: number }, b: { gray: Uint8Array; mean: number; t: number }, global: number) {
    const change = this.countChange(a, b);
    this.judgeChange(change, global, b.t);
    this.usual.push(change.changed);
    if (this.usual.length > USUAL_WINDOW) this.usual.shift();
  }

  /** records a drop unless another was just counted (the same drop seen twice) */
  private addOnset(t: number) {
    if (this.onsets.some((o) => Math.abs(o - t) < SAME_DROP_MS)) return;
    this.onsets.push(t);
  }

  private track(blobs: Blob[], t: number) {
    this.tracks = this.tracks.filter((tr) => t - tr.points[tr.points.length - 1].t <= TRACK_TIMEOUT_MS);
    const used = new Set<Track>();

    for (const b of blobs) {
      let best: Track | null = null;
      let bestCost = Infinity;
      for (const tr of this.tracks) {
        if (used.has(tr)) continue;
        const last = tr.points[tr.points.length - 1];
        const dt = t - last.t;
        const dy = b.y - last.y;
        const dx = Math.abs(b.x - last.x);
        if (dt <= 0 || dy <= 0.5 || dx > MAX_DRIFT || dy > this.height * 0.6) continue;
        let cost = dx;
        if (tr.points.length >= 2) {
          const p = tr.points[tr.points.length - 2];
          const vPrev = (last.y - p.y) / (last.t - p.t);
          const v = dy / dt;
          if (v < vPrev * MIN_SPEEDUP) continue;
          cost += Math.abs(b.y - (last.y + vPrev * dt)) * 0.2;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = tr;
        }
      }
      if (best) {
        best.points.push({ t, x: b.x, y: b.y });
        used.add(best);
        if (TRACKER_COUNTS) this.maybeCount(best);
      } else {
        const tr: Track = { points: [{ t, x: b.x, y: b.y }], counted: false };
        this.tracks.push(tr);
        used.add(tr);
      }
    }
  }

  private maybeCount(tr: Track) {
    if (tr.counted || tr.points.length < MIN_POINTS) return;
    const first = tr.points[0];
    const last = tr.points[tr.points.length - 1];
    if (last.y - first.y < Math.max(6, this.height * MIN_FALL)) return;
    const xs = tr.points.map((p) => p.x);
    if (Math.max(...xs) - Math.min(...xs) > MAX_DRIFT) return;
    const prev = tr.points[tr.points.length - 2];
    const speedPer100ms = ((last.y - prev.y) / (last.t - prev.t)) * 100;
    if (speedPer100ms < this.height * MIN_FALL_SPEED) return;
    tr.counted = true;
    this.addOnset(first.t);
  }
}
