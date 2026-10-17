import type { DetectorOptions } from "@/lib/detect";

/** reads one level per animation frame from a device */
export type Sampler = { sample: () => number; stop: () => void };

export const MIC_DETECTOR: DetectorOptions = { ratio: 3, minDelta: 0.01, refractoryMs: 150, warmupMs: 800 };
export const CAMERA_DETECTOR: DetectorOptions = { ratio: 3, minDelta: 6, refractoryMs: 200, warmupMs: 1500 };

/** the vertical strip of the camera frame watched for falling drops */
export const CAMERA_ROI = { left: 0.35, width: 0.3 };

/** peak loudness of the latest ~20ms of audio, with low rumble filtered out */
export async function micSampler(): Promise<Sampler> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 300;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(filter);
  filter.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  return {
    sample() {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
      return peak;
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

/** number of pixels that changed between frames inside the watched strip */
export async function cameraSampler(video: HTMLVideoElement): Promise<Sampler> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  const W = 160;
  const H = 120;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const x0 = Math.round(W * CAMERA_ROI.left);
  const w = Math.round(W * CAMERA_ROI.width);

  let prev: Uint8ClampedArray | null = null;
  let lastFrameTime = -1;
  let lastValue = 0;

  return {
    sample() {
      if (video.readyState < 2) return 0;
      // the display refreshes faster than the camera; reuse the last frame's value
      if (video.currentTime === lastFrameTime) return lastValue;
      lastFrameTime = video.currentTime;

      ctx.drawImage(video, 0, 0, W, H);
      const { data } = ctx.getImageData(x0, 0, w, H);
      let changed = 0;
      if (prev) {
        for (let i = 0; i < data.length; i += 4) {
          const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          const p = prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114;
          if (Math.abs(g - p) > 18) changed++;
        }
      }
      prev = data;
      lastValue = changed;
      return changed;
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
