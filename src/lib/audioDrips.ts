/**
 * finds drop sounds in raw microphone samples.
 *
 * a drop is a sharp "plink": it jumps out of the background almost instantly,
 * mostly between 1 and 6 khz, and dies away within a fraction of a second.
 * speech, music and fans rise more slowly or last longer, so they're rejected.
 * the background level is learned first, then tracked slowly.
 *
 * the settings are tuned on a real recording of a dripping tap, where each
 * drop rises in 2–6 ms and fades within about 20 ms, with a pitch that glides
 * upward (so a steady-pitch test would wrongly reject it).
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
export type AudioDetectorOptions = {
  /** a drop must be this much louder than the background (energy ratio) */
  snr: number;
  /** ...and this much louder than the moment just before it */
  attack: number;
  /** the loudest point must come this soon after the start */
  maxRiseSec: number;
  /** a drop rings for at least this long (single clicks are shorter)... */
  minRingSec: number;
  /** ...and has died away by this point */
  maxDecaySec: number;
  /** decayed = back below this fraction of the peak, or near the background */
  decayTo: number;
  /** a second sound this soon after a drop is a splash or echo of it */
  refractorySec: number;
  /** share of a drop's energy that must fall in the 1–6 khz band (speech and knocks spread wider) */
  minBandShare: number;
};

export const AUDIO_DEFAULTS: AudioDetectorOptions = {
  snr: 16,
  attack: 6,
  maxRiseSec: 0.014,
  minRingSec: 0.006,
  maxDecaySec: 0.2,
  decayTo: 0.05,
  refractorySec: 0.15,
  minBandShare: 0.35,
};

/** background tracking: falls quickly, rises slowly so bursts don't hide drops */
const NOISE_FALL_SEC = 0.3;
const NOISE_RISE_SEC = 3;
const HISTORY = 8;

/**
 * a steady stream sounds like an even rush of noise with no separate plinks.
 * a fan sounds similar, so this only backs up what the camera sees.
 */
const HISS_BLOCK_SEC = 0.05;
const HISS_WINDOW_BLOCKS = 40;
/** loudness must stay within this spread (relative to its average) over the window */
const HISS_MAX_SPREAD = 0.35;
/** and be clearly above silence (energy in the 1–6 khz band, about −60 dB) */
const HISS_MIN_ENERGY = 1e-6;
/** a dripping tap plinks; a stream doesn't */
const HISS_MAX_PLINKS = 1;

type Candidate = { start: number; peak: number; peakFrame: number; prev: number; band: number; full: number };

export class AudioDropDetector {
  private filters: Biquad[];
  private frameLen: number;
  private acc = 0;
  /** unfiltered energy of the current frame, to see how much of a sound is in the drop band */
  private accFull = 0;
  private fullEnergy = 0;
  private calibrationFull: number[] = [];
  private count = 0;
  private frame = 0;
  /** energies seen while learning the background, checked for drops afterwards */
  private calibration: number[] = [];
  private noise = 0;
  private history: number[] = [];
  private candidate: Candidate | null = null;
  private sustained = false;
  /** loudness of the most recent accepted drop, to keep the louder of two close sounds */
  private lastPeak = 0;
  private o: AudioDetectorOptions;

  /** drop times in seconds since the first sample */
  readonly onsets: number[] = [];
  /** latest level above the background, in db (for display) */
  level = 0;
  private hissAcc = 0;
  private hissCount = 0;
  private hissBlocks: number[] = [];
  /** whether the last two seconds sounded like a steady stream (or another steady rush, like a fan) */
  steadyHiss = false;
  /** sounds that started like a drop but were rejected, and why (for tuning) */
  readonly rejected: { t: number; why: string }[] = [];

  constructor(sampleRate: number, options: Partial<AudioDetectorOptions> = {}) {
    this.o = { ...AUDIO_DEFAULTS, ...options };
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
  get thresholdDb() {
    return 10 * Math.log10(this.o.snr);
  }

  process(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      let y = samples[i];
      this.accFull += y * y;
      for (const f of this.filters) y = f.process(y);
      this.acc += y * y;
      if (++this.count === this.frameLen) {
        this.fullEnergy = this.accFull / this.frameLen;
        this.onFrame(this.acc / this.frameLen);
        this.acc = 0;
        this.accFull = 0;
        this.count = 0;
      }
    }
  }

  private trackHiss(energy: number) {
    this.hissAcc += energy;
    if (++this.hissCount * FRAME_SEC < HISS_BLOCK_SEC) return;
    this.hissBlocks.push(this.hissAcc / this.hissCount);
    this.hissAcc = 0;
    this.hissCount = 0;
    if (this.hissBlocks.length > HISS_WINDOW_BLOCKS) this.hissBlocks.shift();
    if (this.hissBlocks.length < HISS_WINDOW_BLOCKS) return;
    const mean = this.hissBlocks.reduce((a, b) => a + b, 0) / this.hissBlocks.length;
    const sd = Math.sqrt(this.hissBlocks.reduce((a, b) => a + (b - mean) ** 2, 0) / this.hissBlocks.length);
    const now = this.frame * FRAME_SEC;
    const windowSec = HISS_WINDOW_BLOCKS * HISS_BLOCK_SEC;
    const plinks = this.onsets.filter((t) => t > now - windowSec).length;
    this.steadyHiss = mean >= HISS_MIN_ENERGY && sd / mean <= HISS_MAX_SPREAD && plinks <= HISS_MAX_PLINKS;
  }

  private onFrame(energy: number) {
    this.trackHiss(energy);
    const t = this.frame * FRAME_SEC;
    const k = this.frame++;

    if (t < CALIBRATE_SEC) {
      this.calibration.push(energy);
      this.calibrationFull.push(this.fullEnergy);
      if ((k + 1) * FRAME_SEC >= CALIBRATE_SEC) {
        const sorted = [...this.calibration].sort((a, b) => a - b);
        this.noise = Math.max(1e-12, sorted[Math.floor(sorted.length / 2)]);
        // now that the background is known, look for drops in what was heard so far
        this.calibration.forEach((e, i) => {
          this.fullEnergy = this.calibrationFull[i];
          this.detect(e, i);
        });
        this.calibration = [];
        this.calibrationFull = [];
      }
      return;
    }
    this.detect(energy, k);
  }

  private detect(energy: number, k: number) {
    const ratio = energy / this.noise;
    this.level = ratio > 1 ? 10 * Math.log10(ratio) : 0;

    if (this.candidate) {
      const c = this.candidate;
      // a faint sound that runs into a sharp new jump: time the drop from the jump
      if (energy > c.peak && energy >= c.prev * this.o.attack) c.start = k;
      c.prev = energy;
      c.band += energy;
      c.full += this.fullEnergy;
      if (energy > c.peak) {
        c.peak = energy;
        c.peakFrame = k;
      }
      const decayed = energy < c.peak * this.o.decayTo || energy < this.noise * 2;
      const age = (k - c.start) * FRAME_SEC;
      if (decayed) {
        const rise = (c.peakFrame - c.start) * FRAME_SEC;
        const why =
          c.peak < this.noise * this.o.snr
            ? "too quiet"
            : rise > this.o.maxRiseSec
              ? "rose too slowly"
              : age < this.o.minRingSec
                ? "too short"
                : c.band < c.full * this.o.minBandShare
                  ? "spread across too many pitches"
                  : null;
        if (why === null) {
          const at = c.start * FRAME_SEC;
          const last = this.onsets[this.onsets.length - 1];
          if (last !== undefined && at - last < this.o.refractorySec) {
            // two sounds this close are one drop plus a splash or echo: keep the louder
            if (c.peak > this.lastPeak) {
              this.rejected.push({ t: last, why: "quieter than the sound right after it" });
              this.onsets[this.onsets.length - 1] = at;
              this.lastPeak = c.peak;
            } else {
              this.rejected.push({ t: at, why: "echo of the drop just before" });
            }
          } else {
            this.onsets.push(at);
            this.lastPeak = c.peak;
          }
        } else {
          this.rejected.push({ t: c.start * FRAME_SEC, why });
        }
        this.candidate = null;
      } else if (age > this.o.maxDecaySec) {
        // too long to be a drop: wait for this sound to end
        this.rejected.push({ t: c.start * FRAME_SEC, why: "too long" });
        this.candidate = null;
        this.sustained = true;
      }
    } else {
      if (this.sustained && energy < this.noise * 3) this.sustained = false;
      const before = this.history.slice(0, 4);
      const beforeLevel = before.length ? before.reduce((a, b) => a + b, 0) / before.length : energy;
      if (!this.sustained && ratio >= this.o.snr && energy >= beforeLevel * this.o.attack) {
        this.candidate = { start: k, peak: energy, peakFrame: k, prev: energy, band: energy, full: this.fullEnergy };
      }
    }

    if (!this.candidate) {
      const tc = energy < this.noise ? NOISE_FALL_SEC : NOISE_RISE_SEC;
      const alpha = FRAME_SEC / tc;
      this.noise = Math.max(1e-12, this.noise * Math.exp(alpha * Math.log(Math.max(energy, 1e-12) / this.noise)));
    }
    this.pushHistory(energy);
  }

  private pushHistory(energy: number) {
    this.history.push(energy);
    if (this.history.length > HISTORY) this.history.shift();
  }
}
