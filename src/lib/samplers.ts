import { AudioDropDetector } from "@/lib/audioDrips";
import { COLUMN_HALF_WIDTH, VideoDropDetector } from "@/lib/videoDrips";

export { COLUMN_HALF_WIDTH };

export type SamplerStatus = "calibrating" | "listening" | "watching" | "both" | "unsteady" | "stream";

/** what each sensor found, on one clock (ms since the start), for combining */
export type Channels = { seen: number[]; heard: number[]; pictureStream: boolean; soundSteady: boolean };

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
  /** set when both camera and microphone are running */
  channels?: () => Channels;
};

/**
 * opens the microphone and runs the drop detector on every sample. sound
 * times are mapped onto the page clock (performance.now) so they can be lined
 * up with camera frames.
 */
async function startMic() {
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
  let samples = 0;
  // page-clock time of sample 0, estimated from when each chunk arrives (median, to ignore hiccups)
  const offsets: number[] = [];
  let offset = performance.now();
  processor.onaudioprocess = (e) => {
    const chunk = e.inputBuffer.getChannelData(0);
    detector.process(chunk);
    samples += chunk.length;
    offsets.push(performance.now() - (samples / ctx.sampleRate) * 1000);
    if (offsets.length > 50) offsets.shift();
    const sorted = [...offsets].sort((a, b) => a - b);
    offset = sorted[Math.floor(sorted.length / 2)];
  };

  return {
    detector,
    /** page-clock time (ms) of a detector time (s) */
    toPageTime: (sec: number) => offset + sec * 1000,
    stop() {
      processor.onaudioprocess = null;
      processor.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}

/** listens to every microphone sample, not just one snapshot per screen refresh */
export async function micSampler(): Promise<Sampler> {
  const mic = await startMic();
  const { detector } = mic;
  let taken = 0;
  return {
    level: () => detector.level,
    threshold: () => detector.thresholdDb,
    takeOnsets() {
      const fresh = detector.onsets.slice(taken).map((sec) => sec * 1000);
      taken = detector.onsets.length;
      return fresh;
    },
    status: () => (detector.calibrating ? "calibrating" : "listening"),
    stop: mic.stop,
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

type FrameMeta = { mediaTime: number; captureTime?: number; expectedDisplayTime?: number };
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
};

/**
 * runs the drop detector on every camera frame, stamping each frame with the
 * page-clock time it was captured (when the browser knows it) or shown
 */
function startCameraLoop(video: HTMLVideoElement, column: number) {
  const W = 320;
  const H = video.videoWidth ? Math.round((W * video.videoHeight) / video.videoWidth) : 240;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const detector = new VideoDropDetector(W, H, column);
  const v = video as FrameCallbackVideo;
  let running = true;
  let lastMediaTime = -1;

  const grab = (pageTime: number) => {
    if (!running) return;
    ctx.drawImage(video, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    detector.push(gray, pageTime);
  };
  const schedule = () => {
    if (!running) return;
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((now, meta) => {
        grab(meta.captureTime ?? meta.expectedDisplayTime ?? now);
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
    detector,
    stop() {
      running = false;
    },
  };
}

/** watches every camera frame for drops falling down the chosen column (0–1 across) */
export function cameraSampler(video: HTMLVideoElement, column: number, closeCamera: () => void): Sampler {
  const camera = startCameraLoop(video, column);
  const { detector } = camera;
  let taken = 0;
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
      camera.stop();
      closeCamera();
    },
  };
}

/**
 * camera and microphone together, on one clock, for the most accurate count.
 * the column is where the user tapped; the camera must already be open.
 */
export async function combinedSampler(video: HTMLVideoElement, column: number, closeCamera: () => void): Promise<Sampler> {
  const mic = await startMic();
  const camera = startCameraLoop(video, column);
  const startedAt = performance.now();
  let takenSeen = 0;
  let takenHeard = 0;
  const seenTimes = () => camera.detector.onsets.map((t) => t - startedAt);
  const heardTimes = () => mic.detector.onsets.map((sec) => mic.toPageTime(sec) - startedAt);

  return {
    level: () => mic.detector.level,
    threshold: () => mic.detector.thresholdDb,
    takeOnsets() {
      const seen = seenTimes().slice(takenSeen);
      const heard = heardTimes().slice(takenHeard);
      takenSeen += seen.length;
      takenHeard += heard.length;
      return [...seen, ...heard];
    },
    status() {
      const cam = camera.detector.status;
      if (mic.detector.calibrating || cam === "calibrating") return "calibrating";
      if (cam === "unsteady" || cam === "stream") return cam;
      return "both";
    },
    channels: () => ({
      seen: seenTimes(),
      heard: heardTimes(),
      pictureStream: camera.detector.stream,
      soundSteady: mic.detector.steadyHiss,
    }),
    stop() {
      camera.stop();
      mic.stop();
      closeCamera();
    },
  };
}
