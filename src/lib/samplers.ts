import { AudioDropDetector } from "@/lib/audioDrips";
import { COLUMN_HALF_WIDTH, VideoDropDetector } from "@/lib/videoDrips";

export { COLUMN_HALF_WIDTH };

export type SamplerStatus = "calibrating" | "listening" | "watching" | "unsteady" | "stream";

/** a running detector attached to a device */
export type Sampler = {
  /** latest level, for the live trace */
  level: () => number;
  /** the level a sound must reach to count, when there is a single line */
  threshold: () => number | null;
  /** drop times (ms since the start) found since the last call */
  takeOnsets: () => number[];
  status: () => SamplerStatus;
  stop: () => void;
};

/** listens to every microphone sample, not just one snapshot per screen refresh */
export async function micSampler(): Promise<Sampler> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  // the processor only runs while connected to the output; keep it silent
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const detector = new AudioDropDetector(ctx.sampleRate);
  processor.onaudioprocess = (e) => detector.process(e.inputBuffer.getChannelData(0));
  let taken = 0;

  return {
    level: () => detector.level,
    threshold: () => detector.thresholdDb,
    takeOnsets() {
      const fresh = detector.onsets.slice(taken).map((s) => s * 1000);
      taken = detector.onsets.length;
      return fresh;
    },
    status: () => (detector.calibrating ? "calibrating" : "listening"),
    stop() {
      processor.onaudioprocess = null;
      processor.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

/** starts the camera and shows it in the video element; returns a function that turns it off */
export async function openCamera(video: HTMLVideoElement): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 60 },
    },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return () => {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

/** watches every camera frame for drops falling down the chosen column (0–1 across) */
export function cameraSampler(video: HTMLVideoElement, column: number, closeCamera: () => void): Sampler {
  const W = 320;
  const H = video.videoWidth ? Math.round((W * video.videoHeight) / video.videoWidth) : 240;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const detector = new VideoDropDetector(W, H, column);
  const v = video as FrameCallbackVideo;

  let running = true;
  let taken = 0;
  let firstFrameAt: number | null = null;
  let lastMediaTime = -1;

  const grab = (frameTimeMs: number) => {
    if (!running) return;
    if (firstFrameAt === null) firstFrameAt = frameTimeMs;
    ctx.drawImage(video, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    detector.push(gray, frameTimeMs - firstFrameAt);
  };

  const schedule = () => {
    if (!running) return;
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((_now, meta) => {
        grab(meta.mediaTime * 1000);
        schedule();
      });
    } else {
      requestAnimationFrame(() => {
        if (video.currentTime !== lastMediaTime) {
          lastMediaTime = video.currentTime;
          grab(performance.now());
        }
        schedule();
      });
    }
  };
  schedule();

  return {
    level: () => detector.level,
    threshold: () => null,
    takeOnsets() {
      const fresh = detector.onsets.slice(taken);
      taken = detector.onsets.length;
      return fresh;
    },
    status: () => detector.status,
    stop() {
      running = false;
      closeCamera();
    },
  };
}
