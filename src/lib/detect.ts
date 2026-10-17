/** rolling history of levels, drawn as a trace with a tick per detected drop */
export class Trace {
  private values: number[] = [];
  private thresholds: (number | null)[] = [];
  private hits: boolean[] = [];

  constructor(private size = 300) {}

  push(value: number, threshold: number | null, hit: boolean) {
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
      max = Math.max(max, this.values[i], (this.thresholds[i] ?? 0) * 1.5);
    }
    const step = w / (this.size - 1);
    const offset = this.size - this.values.length;
    const y = (v: number) => h - 2 - (v / max) * (h - 4);

    ctx.fillStyle = "#8ec3e3";
    this.hits.forEach((hit, i) => {
      if (hit) ctx.fillRect((offset + i) * step - 1, 0, 2, h);
    });

    ctx.strokeStyle = "#c8e1f2";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    let drawing = false;
    this.thresholds.forEach((v, i) => {
      const x = (offset + i) * step;
      if (v === null) {
        drawing = false;
      } else if (drawing) {
        ctx.lineTo(x, y(v));
      } else {
        ctx.moveTo(x, y(v));
        drawing = true;
      }
    });
    ctx.stroke();

    ctx.strokeStyle = "#4d73ad";
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
