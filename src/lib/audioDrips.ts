/**
 * finds drop sounds in raw microphone samples.
 *
 * a drop is a sharp "plink": it jumps out of the background almost instantly,
 * mostly between 1 and 6 khz, and dies away within a fraction of a second.
 * speech, music and fans rise more slowly or last longer, so they're rejected.
 * the background level is learned first, then tracked slowly.
 */

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}

  static make(type: "lowpass" | "highpass", sampleRate: number, freq: number) {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = type === "lowpass" ? (1 - cos) / 2 : (1 + cos) / 2;
    const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
    return new Biquad(b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  process(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const FRAME_SEC = 0.002;
/** time spent learning the background before counting */
export const CALIBRATE_SEC = 2;
/** a drop must be this much louder than the background (energy ratio, ~12 db) */
const SNR = 16;
/** ...and this much louder than the moment just before it (~8 db) */
const ATTACK = 6;
/** the loudest point must come this soon after the start */
const MAX_RISE_SEC = 0.014;
/** a drop rings for at least this long (clicks and speech bursts are shorter)... */
const MIN_RING_SEC = 0.02;
/** ...and has died away by this point */
const MAX_DECAY_SEC = 0.2;
/** a drop rings like a tone: zero crossings stay evenly spaced (noise bursts don't) */
const MAX_CROSSING_SPREAD = 0.3;
const TONE_WINDOW_SEC = 0.02;
/** decayed = back below this fraction of the peak, or near the background */
const DECAY_TO = 0.05;
const REFRACTORY_SEC = 0.08;
/** background tracking: falls quickly, rises slowly so bursts don't hide drops */
const NOISE_FALL_SEC = 0.3;
const NOISE_RISE_SEC = 3;
const HISTORY = 8;

type Candidate = { start: number; peak: number; peakFrame: number };

export class AudioDropDetector {
  private filters: Biquad[];
  private frameLen: number;
  private acc = 0;
  private count = 0;
  private frame = 0;
  private calibration: number[] = [];
  private noise = 0;
  private history: number[] = [];
  private candidate: Candidate | null = null;
  private sustained = false;
  private quietUntil = 0;
  private sample = 0;
  private lastY = 0;
  /** recent zero crossings (sample positions) of the filtered signal */
  private crossings: number[] = [];
  private sampleRate: number;

  /** drop times in seconds since the first sample */
  readonly onsets: number[] = [];
  /** latest level above the background, in db (for display) */
  level = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.max(1, Math.round(sampleRate * FRAME_SEC));
    this.filters = [
      Biquad.make("highpass", sampleRate, 1000),
      Biquad.make("highpass", sampleRate, 1000),
      Biquad.make("lowpass", sampleRate, 6000),
      Biquad.make("lowpass", sampleRate, 6000),
    ];
  }

  get calibrating() {
    return this.frame * FRAME_SEC < CALIBRATE_SEC;
  }

  /** db above the background a sound needs to count */
  static readonly thresholdDb = 10 * Math.log10(SNR);

  process(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      let y = samples[i];
      for (const f of this.filters) y = f.process(y);
      if ((y >= 0) !== (this.lastY >= 0)) {
        this.crossings.push(this.sample);
        if (this.crossings.length > 2000) this.crossings.splice(0, 1000);
      }
      this.lastY = y;
      this.sample++;
      this.acc += y * y;
      if (++this.count === this.frameLen) {
        this.onFrame(this.acc / this.frameLen);
        this.acc = 0;
        this.count = 0;
      }
    }
  }

  private onFrame(energy: number) {
    const t = this.frame * FRAME_SEC;
    const k = this.frame++;

    if (t < CALIBRATE_SEC) {
      this.calibration.push(energy);
      if ((k + 1) * FRAME_SEC >= CALIBRATE_SEC) {
        const sorted = [...this.calibration].sort((a, b) => a - b);
        this.noise = Math.max(1e-12, sorted[Math.floor(sorted.length / 2)]);
      }
      this.pushHistory(energy);
      return;
    }

    const ratio = energy / this.noise;
    this.level = ratio > 1 ? 10 * Math.log10(ratio) : 0;

    if (this.candidate) {
      const c = this.candidate;
      if (energy > c.peak) {
        c.peak = energy;
        c.peakFrame = k;
      }
      const decayed = energy < c.peak * DECAY_TO || energy < this.noise * 2;
      const age = (k - c.start) * FRAME_SEC;
      if (decayed) {
        const rise = (c.peakFrame - c.start) * FRAME_SEC;
        if (c.peak >= this.noise * SNR && rise <= MAX_RISE_SEC && age >= MIN_RING_SEC && this.isTonal(c.start)) {
          this.onsets.push(c.start * FRAME_SEC);
          this.quietUntil = c.start * FRAME_SEC + REFRACTORY_SEC;
        }
        this.candidate = null;
      } else if (age > MAX_DECAY_SEC) {
        // too long to be a drop: wait for this sound to end
        this.candidate = null;
        this.sustained = true;
      }
    } else {
      if (this.sustained && energy < this.noise * 3) this.sustained = false;
      const before = this.history.slice(0, 4);
      const beforeLevel = before.length ? before.reduce((a, b) => a + b, 0) / before.length : energy;
      if (!this.sustained && t >= this.quietUntil && ratio >= SNR && energy >= beforeLevel * ATTACK) {
        this.candidate = { start: k, peak: energy, peakFrame: k };
      }
    }

    if (!this.candidate) {
      const tc = energy < this.noise ? NOISE_FALL_SEC : NOISE_RISE_SEC;
      const alpha = FRAME_SEC / tc;
      this.noise = Math.max(1e-12, this.noise * Math.exp(alpha * Math.log(Math.max(energy, 1e-12) / this.noise)));
    }
    this.pushHistory(energy);
  }

  /** whether the sound starting at this frame rings at a steady pitch */
  private isTonal(startFrame: number) {
    const from = startFrame * this.frameLen;
    const to = from + TONE_WINDOW_SEC * this.sampleRate;
    const xs = this.crossings.filter((c) => c >= from && c < to);
    if (xs.length < 6) return false;
    const gaps = xs.slice(1).map((c, i) => c - xs[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    return sd / mean <= MAX_CROSSING_SPREAD;
  }

  private pushHistory(energy: number) {
    this.history.push(energy);
    if (this.history.length > HISTORY) this.history.shift();
  }
}
