import { AudioDropDetector } from "@/lib/audioDrips";
import { analyze, type Measurement } from "@/lib/drips";
import { VideoDropDetector } from "@/lib/videoDrips";

/**
 * runs the same detectors used live on a saved recording, so a video of a
 * drip can be checked frame by frame and sample by sample
 */

export type RecordingResult = {
  sound: Measurement | null;
  picture: { measurement: Measurement; isStream: boolean } | null;
};

/** drops heard in the recording's sound track, or null if it has none */
export async function analyzeSound(file: Blob): Promise<Measurement | null> {
  let audio: AudioBuffer;
  try {
    const data = await file.arrayBuffer();
    audio = await new OfflineAudioContext(1, 48000, 48000).decodeAudioData(data);
  } catch {
    return null;
  }
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  const detector = new AudioDropDetector(audio.sampleRate);
  for (let i = 0; i < mono.length; i += 2048) detector.process(mono.subarray(i, i + 2048));
  return analyze(
    "mic",
    detector.onsets.map((s) => s * 1000),
    audio.duration * 1000,
  );
}

const FPS = 30;
const WIDTH = 320;

/**
 * drops seen falling down the chosen column (0–1 across) of the video,
 * stepping through it one frame at a time
 */
export async function analyzePicture(
  video: HTMLVideoElement,
  column: number,
  onProgress: (share: number) => void,
): Promise<RecordingResult["picture"]> {
  if (!video.videoWidth || !Number.isFinite(video.duration)) return null;
  const H = Math.round((WIDTH * video.videoHeight) / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const detector = new VideoDropDetector(WIDTH, H, column);
  const frames = Math.floor(video.duration * FPS);
  let streamFrames = 0;

  video.pause();
  for (let i = 0; i < frames; i++) {
    video.currentTime = (i + 0.5) / FPS;
    await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    ctx.drawImage(video, 0, 0, WIDTH, H);
    const { data } = ctx.getImageData(0, 0, WIDTH, H);
    const gray = new Uint8Array(WIDTH * H);
    for (let k = 0; k < gray.length; k++) gray[k] = (data[k * 4] * 77 + data[k * 4 + 1] * 150 + data[k * 4 + 2] * 29) >> 8;
    detector.push(gray, (i * 1000) / FPS);
    if (detector.status === "stream") streamFrames++;
    if (i % 10 === 0) onProgress(i / frames);
  }
  onProgress(1);
  video.currentTime = 0;
  return { measurement: analyze("camera", detector.onsets, video.duration * 1000), isStream: streamFrames > frames * 0.5 };
}
