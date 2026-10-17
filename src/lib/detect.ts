export type DetectorOptions = {
  /** how many times above the background level a spike must be */
  ratio: number;
  /** minimum absolute rise above the background level */
  minDelta: number;
  /** ignore new spikes this soon after a drop (echoes, splashes) */
  refractoryMs: number;
  /** time spent learning the background level before counting */
  warmupMs: number;
};

/**
 * finds short spikes in a stream of levels (mic loudness or camera motion).
 * the background level adapts slowly, so steady noise doesn't count as drops.
 */
export class OnsetDetector {
  private floor = 0;
  private startedAt = -1;
  private armed = true;
  private lastHit = -Infinity;

  constructor(private o: DetectorOptions) {}

  threshold() {
    return this.floor * this.o.ratio + this.o.minDelta;
  }

  push(value: number, t: number): boolean {
    if (this.startedAt < 0) {
      this.startedAt = t;
      this.floor = value;
    }
    const warm = t - this.startedAt < this.o.warmupMs;
    const th = this.threshold();

    let hit = false;
    if (!warm && this.armed && value > th && t - this.lastHit >= this.o.refractoryMs) {
      hit = true;
      this.lastHit = t;
      this.armed = false;
    }
    // re-arm only once the level has dropped back down (hysteresis)
    if (value < this.floor + (th - this.floor) * 0.5) this.armed = true;
    // spikes don't raise the background level; it falls faster than it rises
    if (warm || value < th) this.floor += (value - this.floor) * (value > this.floor ? 0.01 : 0.05);

    return hit;
  }
}

/** rolling history of levels, drawn as a trace with a tick per detected drop */
export class Trace {
  private values: number[] = [];
  private thresholds: number[] = [];
  private hits: boolean[] = [];

  constructor(private size = 300) {}

  push(value: number, threshold: number, hit: boolean) {
    this.values.push(value);
    this.thresholds.push(threshold);
    this.hits.push(hit);
    if (this.values.length > this.size) {
      this.values.shift();
      this.thresholds.shift();
      this.hits.shift();
    }
  }

  draw(canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let max = 1e-6;
    for (let i = 0; i < this.values.length; i++) {
      max = Math.max(max, this.values[i], this.thresholds[i] * 1.5);
    }
    const step = w / (this.size - 1);
    const offset = this.size - this.values.length;
    const y = (v: number) => h - 2 - (v / max) * (h - 4);

    ctx.fillStyle = "#2563eb";
    this.hits.forEach((hit, i) => {
      if (hit) ctx.fillRect((offset + i) * step - 1, 0, 2, h);
    });

    ctx.strokeStyle = "#d4d4d4";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    this.thresholds.forEach((v, i) => {
      const x = (offset + i) * step;
      if (i === 0) ctx.moveTo(x, y(v));
      else ctx.lineTo(x, y(v));
    });
    ctx.stroke();

    ctx.strokeStyle = "#171717";
    ctx.setLineDash([]);
    ctx.beginPath();
    this.values.forEach((v, i) => {
      const x = (offset + i) * step;
      if (i === 0) ctx.moveTo(x, y(v));
      else ctx.lineTo(x, y(v));
    });
    ctx.stroke();
  }
}
