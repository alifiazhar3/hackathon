/** synthetic recordings and video for testing the drop detectors */

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

// ---------- audio ----------

export const SR = 48000;

/**
 * a water drop "plink", modelled on a real recording: a tone around 1.4–2.3 khz
 * that glides upward in pitch and fades within ~20 ms, plus a tiny click
 */
function addPlink(buf: Float32Array, at: number, amp: number, r: () => number) {
  const freq = 1400 + r() * 900;
  const glide = 0.2 + r() * 0.3;
  const tau = 0.005 + r() * 0.004;
  const start = Math.floor(at * SR);
  const len = Math.floor(tau * 8 * SR);
  let phase = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    phase += (2 * Math.PI * freq * (1 + glide * Math.min(1, t / 0.02))) / SR;
    let v = amp * Math.exp(-t / tau) * Math.sin(phase);
    if (t < 0.002) v += amp * 0.5 * gauss(r) * (1 - t / 0.002);
    buf[start + i] += v;
  }
}

/** drips at a steady interval with natural jitter; returns the true drop times (s) */
/** plinks at exactly these times (s), e.g. when drops seen on video land */
export function addPlinksAt(buf: Float32Array, timesSec: number[], amp: number, r: () => number) {
  for (const t of timesSec) if (t >= 0 && t < buf.length / SR - 0.1) addPlink(buf, t, amp * (0.75 + r() * 0.5), r);
}

/** seconds a synthetic video drop takes to fall, so its sound can be placed where it lands */
export const FALL_SEC = Math.sqrt((2 * 0.12) / 9.81);

export function addDrips(buf: Float32Array, intervalSec: number, amp: number, r: () => number, startSec = 0.3) {
  const times: number[] = [];
  const dur = buf.length / SR;
  for (let t = startSec; t < dur - 0.3; t += intervalSec * (1 + gauss(r) * 0.02)) {
    times.push(t);
    addPlink(buf, t, amp * (0.75 + r() * 0.5), r);
  }
  return times;
}

/** broadband hiss, like a fan or traffic */
export function addHiss(buf: Float32Array, rms: number, r: () => number) {
  for (let i = 0; i < buf.length; i++) buf[i] += rms * gauss(r);
}

/** talking: voiced syllables with harmonics, plus "s" sounds and plosive bursts */
export function addSpeech(buf: Float32Array, rms: number, r: () => number) {
  let t = 0.1;
  const dur = buf.length / SR;
  let phase = 0;
  while (t < dur) {
    const syl = 0.12 + r() * 0.2;
    const f0 = 100 + r() * 120;
    const start = Math.floor(t * SR);
    const len = Math.floor(syl * SR);
    // plosive (p, t, k): a short sharp burst
    if (r() < 0.35) {
      for (let i = 0; i < 0.015 * SR && start + i < buf.length; i++) {
        buf[start + i] += rms * 2.5 * gauss(r) * Math.exp(-i / (0.004 * SR));
      }
    }
    // fricative (s, sh): bright noise
    if (r() < 0.3) {
      let lp = 0;
      for (let i = 0; i < 0.09 * SR && start + i < buf.length; i++) {
        const n = gauss(r);
        const hp = n - lp;
        lp += (n - lp) * 0.3;
        const env = Math.min(1, i / (0.012 * SR)) * Math.min(1, (0.09 * SR - i) / (0.02 * SR));
        buf[start + i] += rms * 1.2 * hp * env;
      }
    }
    for (let i = 0; i < len && start + i < buf.length; i++) {
      const env = Math.min(1, i / (0.03 * SR)) * Math.min(1, (len - i) / (0.04 * SR));
      phase += (2 * Math.PI * f0) / SR;
      let v = 0;
      for (let k = 1; k <= 30; k++) {
        const fk = f0 * k;
        // vowel-ish formant bumps around 700, 1200 and 2600 hz
        const g = 1 / k + 0.6 * Math.exp(-(((fk - 700) / 250) ** 2)) + 0.4 * Math.exp(-(((fk - 1200) / 300) ** 2)) + 0.25 * Math.exp(-(((fk - 2600) / 400) ** 2));
        v += g * Math.sin(k * phase);
      }
      buf[start + i] += rms * 0.9 * env * v;
    }
    t += syl + 0.04 + r() * 0.2;
  }
}

/** music: piano-like notes at irregular times with long ringing tails */
export function addMusic(buf: Float32Array, amp: number, r: () => number) {
  let t = 0.1;
  const dur = buf.length / SR;
  while (t < dur) {
    const f = 200 * 2 ** (Math.floor(r() * 24) / 12);
    const start = Math.floor(t * SR);
    const len = Math.floor(1.5 * SR);
    for (let i = 0; i < len && start + i < buf.length; i++) {
      const s = i / SR;
      const env = Math.min(1, s / 0.004) * Math.exp(-s / 0.5);
      let v = 0;
      for (let k = 1; k <= 8; k++) v += Math.sin(2 * Math.PI * f * k * s) / k;
      buf[start + i] += amp * env * v;
    }
    t += 0.2 + r() * 0.5;
  }
}

/** clatter: drop-like knocks at random times (dishes, keys, footsteps) */
export function addClatter(buf: Float32Array, perSec: number, amp: number, r: () => number) {
  const dur = buf.length / SR;
  let t = 0.2;
  while (t < dur) {
    t += -Math.log(1 - r()) / perSec;
    if (t < dur) addPlink(buf, t, amp * (0.5 + r()), r);
  }
}

// ---------- video ----------

export const VW = 320;
export const VH = 240;
export const FPS = 30;

export type VideoScene = {
  durationSec: number;
  /** seconds between drops, or null for no drops */
  intervalSec: number | null;
  /** where drops fall, as a fraction of the width */
  column: number;
  /** pixels the drop falls (the fall must be in view) */
  fallPx: number;
  dropContrast: number;
  sensorNoise: number;
  /** brightness wobble from auto-exposure / mains flicker, in grey levels */
  flicker: number;
  /** chance per frame of the camera jolting by a few pixels */
  shake: number;
  /** a large object (a hand) sweeping sideways through the column every so often */
  hand: boolean;
  /** small things (bugs, dust) drifting sideways or up through the column */
  insects: number;
  /** a steady stream of water down the column instead of drops */
  stream?: boolean;
  /** a still vertical pipe or shadow in the column */
  pipe?: boolean;
};

/** renders frames one at a time; returns the true drop times (ms) */
export function renderVideo(scene: VideoScene, seed: number, onFrame: (gray: Uint8Array, tMs: number) => void) {
  const r = rng(seed);
  // static textured background (a tiled wall)
  const bg = new Float32Array(VW * VH);
  for (let y = 0; y < VH; y++) {
    for (let x = 0; x < VW; x++) {
      bg[y * VW + x] = 110 + 25 * Math.sin(x / 9) * Math.sin(y / 13) + ((x % 40 < 2 || y % 40 < 2) ? -30 : 0) + gauss(r) * 6;
    }
  }
  const drops: number[] = [];
  if (scene.intervalSec) {
    for (let t = 0.4; t < scene.durationSec - 0.5; t += scene.intervalSec * (1 + gauss(r) * 0.02)) drops.push(t);
  }
  // the fall takes sqrt(2h/g); scale so fallPx pixels ≈ 12 cm of fall
  const fallSec = Math.sqrt((2 * 0.12) / 9.81);
  const g = (2 * scene.fallPx) / fallSec ** 2;
  const cx = scene.column * VW;
  const topY = 30;

  const insects = Array.from({ length: scene.insects }, () => ({
    x: r() * VW,
    y: 40 + r() * 150,
    vx: (r() < 0.5 ? -1 : 1) * (40 + r() * 80),
    vy: -(10 + r() * 40),
  }));

  const frames = Math.floor(scene.durationSec * FPS);
  let shakeX = 0;
  let shakeY = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    if (r() < scene.shake) {
      shakeX = Math.round(gauss(r) * 3);
      shakeY = Math.round(gauss(r) * 3);
    } else if (r() < 0.3) {
      shakeX = 0;
      shakeY = 0;
    }
    const bright = scene.flicker * Math.sin(2 * Math.PI * 3.3 * t) + scene.flicker * 0.5 * gauss(r);
    const img = new Float32Array(VW * VH);
    for (let y = 0; y < VH; y++) {
      const sy = Math.min(VH - 1, Math.max(0, y + shakeY));
      for (let x = 0; x < VW; x++) {
        const sx = Math.min(VW - 1, Math.max(0, x + shakeX));
        img[y * VW + x] = bg[sy * VW + sx] + bright;
      }
    }
    // drops: small bright ovals, stretched a little by motion blur
    for (const d of drops) {
      const s = t - d;
      if (s < 0 || s > fallSec) continue;
      const y = topY + 0.5 * g * s * s;
      const v = g * s;
      const len = 2 + Math.min(8, v / FPS / 2);
      for (let yy = Math.floor(y - len); yy <= Math.ceil(y + len); yy++) {
        for (let xx = Math.floor(cx - 2); xx <= Math.ceil(cx + 2); xx++) {
          if (yy < 0 || yy >= VH || xx < 0 || xx >= VW) continue;
          const k = Math.exp(-(((xx - cx) / 1.4) ** 2) - (((yy - y) / len) ** 2));
          img[yy * VW + xx] += scene.dropContrast * k;
        }
      }
    }
    if (scene.pipe) {
      for (let y = 0; y < VH; y++) for (let x = Math.floor(cx - 3); x <= cx + 3; x++) img[y * VW + x] = 40;
    }
    // a stream: a thin bright line whose ripples slide downward
    if (scene.stream) {
      for (let y = topY; y < VH; y++) {
        for (let x = Math.floor(cx - 2); x <= Math.ceil(cx + 2); x++) {
          const ripple = 0.55 + 0.45 * Math.sin(y / 2.5 - t * 60 + Math.sin(y / 7) * 2);
          img[y * VW + x] += scene.dropContrast * ripple * Math.exp(-(((x - cx) / 1.6) ** 2));
        }
      }
    }
    // a hand sweeping through every 4 s
    if (scene.hand && t % 4 < 0.6) {
      const hx = -60 + ((t % 4) / 0.6) * (VW + 120);
      for (let y = 60; y < 200; y++) for (let x = Math.max(0, Math.floor(hx - 40)); x < Math.min(VW, hx + 40); x++) img[y * VW + x] = 180;
    }
    for (const b of insects) {
      const bx = (((b.x + b.vx * t) % VW) + VW) % VW;
      const by = (((b.y + b.vy * t) % VH) + VH) % VH;
      for (let yy = Math.floor(by - 1); yy <= by + 1; yy++) for (let xx = Math.floor(bx - 1); xx <= bx + 1; xx++) {
        if (yy >= 0 && yy < VH && xx >= 0 && xx < VW) img[yy * VW + xx] = 30;
      }
    }
    const gray = new Uint8Array(VW * VH);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round(img[i] + gauss(r) * scene.sensorNoise)));
    onFrame(gray, t * 1000 + gauss(r) * 2);
  }
  return drops.map((d) => d * 1000);
}
