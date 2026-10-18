import { AudioDropDetector } from "@/lib/audioDrips";
import { analyze, type Measurement } from "@/lib/drips";
import { fuse, fuseStream, type Fused } from "@/lib/fusion";
import { findPeriodAnywhere, type Period } from "@/lib/periodic";
import { Stabilizer, VideoDropDetector } from "@/lib/videoDrips";

/**
 * runs the same detectors used live on a saved recording, so a video of a
 * drip can be checked frame by frame and sample by sample, then combined.
 * many videos have no sound, or sound that isn't quite in sync with the
 * picture, so either sensor can carry the result on its own.
 */

export type SoundResult = { measurement: Measurement; heard: number[]; steady: boolean };
export type PictureResult = {
  measurement: Measurement;
  seen: number[];
  isStream: boolean;
  /** where across the picture (0–1) the drops were found */
  column: number;
};

export type RecordingResult = {
  sound: SoundResult | null;
  picture: PictureResult | null;
  combined: { measurement: Fused | null; stream: ReturnType<typeof fuseStream> } | null;
};

/**
 * phone videos can be hundreds of megabytes; reading one whole into memory to
 * get its sound can stall or crash a phone's browser, so bigger files are
 * judged on the picture alone
 */
const MAX_SOUND_FILE_BYTES = 120 * 1024 * 1024;
/** some browsers never finish decoding the sound of certain videos */
const SOUND_TIMEOUT_MS = 20_000;

/** drops heard in the recording's sound track, or null if it has none (or it can't be read in time) */
export async function analyzeSound(file: Blob): Promise<SoundResult | null> {
  if (file.size > MAX_SOUND_FILE_BYTES) return null;
  let audio: AudioBuffer;
  try {
    const decode = file.arrayBuffer().then((data) => new OfflineAudioContext(1, 48000, 48000).decodeAudioData(data));
    const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), SOUND_TIMEOUT_MS));
    const decoded = await Promise.race([decode, timeout]);
    if (!decoded) return null;
    audio = decoded;
  } catch {
    return null;
  }
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  return analyzeSamples(mono, audio.sampleRate);
}

/** drops heard in raw mono samples */
export function analyzeSamples(mono: Float32Array, sampleRate: number): SoundResult | null {
  // a silent track (a video filmed without sound) says nothing either way
  let peak = 0;
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 0.001) return null;

  const detector = new AudioDropDetector(sampleRate);
  // the steady-rush check looks at the last 2 s, so note it wherever it held for most of the clip
  let steadyBlocks = 0;
  let blocks = 0;
  for (let i = 0; i < mono.length; i += 2048) {
    detector.process(mono.subarray(i, i + 2048));
    blocks++;
    if (detector.steadyHiss) steadyBlocks++;
  }
  const heard = detector.onsets.map((s) => s * 1000);
  return {
    measurement: analyze("mic", heard, (mono.length / sampleRate) * 1000),
    heard,
    steady: steadyBlocks > blocks * 0.4,
  };
}

const WIDTH = 320;
/** reading the picture may take up to this many times the video's length... */
const ANALYSIS_TIME_SHARE = 3;
/** ...but always gets at least this long */
const MIN_ANALYSIS_MS = 45_000;
/** videos are played at most this much faster than real time while every frame is read */
const MAX_PLAY_RATE = 2;
/** ...and at least this fast, even on a slow device */
const MIN_PLAY_RATE = 0.5;
/** frames closer together than this are skipped */
const MIN_FRAME_GAP_MS = 30;
/** columns searched for the drip, besides the one tapped */
const SEARCH_COLUMNS = Array.from({ length: 13 }, (_, i) => 0.08 + i * 0.07);

/**
 * watches every column of the picture at once, so the drip is found even if
 * the tap wasn't quite on it (or the drops fall somewhere else entirely)
 */
export class ColumnSearch {
  private watchers: { column: number; detector: VideoDropDetector; streamFrames: number }[];
  private frames = 0;
  private steady: Stabilizer;
  private lastT = -Infinity;

  constructor(
    width: number,
    height: number,
    private tap: number,
  ) {
    this.steady = new Stabilizer(width, height);
    const columns = [tap, ...SEARCH_COLUMNS.filter((c) => Math.abs(c - tap) > 0.035)];
    this.watchers = columns.map((column) => ({ column, detector: new VideoDropDetector(width, height, column), streamFrames: 0 }));
  }

  push(raw: Uint8Array, t: number) {
    // the detectors are tuned for about 30 frames a second: a 60 fps phone video's
    // extra frames only halve each change and double the work
    if (t - this.lastT < MIN_FRAME_GAP_MS) return;
    this.lastT = t;
    this.frames++;
    const gray = this.steady.push(raw);
    for (const w of this.watchers) {
      w.detector.push(gray, t);
      if (w.detector.status === "stream") w.streamFrames++;
    }
  }

  result(durationMs: number): PictureResult {
    const periods = this.watchers.map((w) => findPeriodAnywhere(w.detector.activity.t, w.detector.activity.column));
    const typicalStrength = [...periods.map((p) => p.strength)].sort((x, y) => x - y)[Math.floor(periods.length / 2)];
    const looked = this.watchers.map((w, i) => {
      const events = analyze("camera", w.detector.onsets, durationMs);
      // a rhythm counts only where it is much clearer than in a typical column (a drip),
      // not everywhere at once (flicker, the video's own compression)
      const local = periods[i].strength - typicalStrength >= RHYTHM_CONTRAST;
      return { ...w, m: bestOf(events, local ? periods[i] : null, durationMs), stream: w.streamFrames / Math.max(1, this.frames) };
    });
    const usable = (m: Measurement) => m.dropsPerMin !== null && m.confidence !== "low";
    const rank = (m: Measurement) => (m.confidence === "high" ? 2 : m.confidence === "medium" ? 1 : 0);
    const clearest = (list: typeof looked) =>
      list.filter((w) => usable(w.m)).sort((x, y) => rank(y.m) - rank(x.m) || y.m.drops - x.m.drops || Math.abs(x.column - this.tap) - Math.abs(y.column - this.tap))[0];
    const away = (w: (typeof looked)[number]) => Math.abs(w.column - this.tap);

    const tapped = looked[0];
    const near = looked.filter((w) => away(w) <= NEAR_TAP);
    const counted = (w: (typeof looked)[number]) => usable(w.m) && !w.m.byRhythm;
    // drops counted where the user tapped (or right next to it)...
    const drip = counted(tapped) ? tapped : clearest(near.filter(counted));
    const byStream = (list: typeof looked) => list.sort((x, y) => y.stream - x.stream)[0];
    // ...then what the tapped column itself shows: a stream, or a drip's rhythm...
    const tappedStream = tapped.stream > 0.3 ? tapped : undefined;
    // ...then the same just around it, a very clear stream anywhere, the clearest
    // drip anywhere, and last a slow drip of only a few drops
    const streamNear = byStream(looked.filter((w) => away(w) <= 0.2 && w.stream > 0.5));
    const streamAnywhere = byStream(looked.filter((w) => w.stream > 0.75));
    const streamHere = tappedStream ?? streamNear;
    const chosen =
      drip ??
      tappedStream ??
      (usable(tapped.m) ? tapped : undefined) ??
      streamNear ??
      clearest(near) ??
      streamAnywhere ??
      clearest(looked) ??
      near.map((w) => roughDrip(w, durationMs)).find(Boolean) ??
      tapped;
    return {
      measurement: chosen.m,
      seen: [...chosen.detector.onsets],
      isStream: (chosen === streamHere || chosen === streamAnywhere) && !usable(chosen.m),
      column: chosen.column,
    };
  }
}

/** columns this close to the tapped one count as where the user tapped */
const NEAR_TAP = 0.1;
/** a column's rhythm counts if it is at least this much clearer than in a typical column */
const RHYTHM_CONTRAST = 0.2;
/** how alike the picture must be one drip apart for its rhythm alone to count */
const RHYTHM_STRENGTH = 0.5;

/**
 * a column's drip rate, from counting drops one by one or from the rhythm of
 * how the column changes, whichever is clearer. counting is exact when each
 * drop stands out; the rhythm still works when drops are tiny, slow-motion or
 * blurred into each other.
 */
function bestOf(events: Measurement, period: Period | null, durationMs: number): Measurement {
  const counted = events.dropsPerMin !== null && events.confidence !== "low";
  if (!period?.periodMs || period.strength < RHYTHM_STRENGTH) return events;
  const rate = 60000 / period.periodMs;
  // both found the same drip: counting is the more exact
  if (counted && Math.abs(events.dropsPerMin! - rate) / rate < 0.15) return events;
  // counting is sure and the rhythm isn't: trust counting
  if (events.confidence === "high" && period.strength < 0.7) return events;
  return {
    ...events,
    drops: Math.max(events.drops, Math.round(durationMs / period.periodMs)),
    dropsPerMin: rate,
    intervalMs: period.periodMs,
    confidence: period.strength >= 0.75 ? "high" : "medium",
    byRhythm: true,
    reason: null,
  };
}

/**
 * a slow drip shows only two or three drops in a short clip: too few to be
 * sure of a rhythm, but still a leak. their spacing gives a rough rate.
 */
function roughDrip<T extends { m: Measurement; detector: VideoDropDetector }>(w: T, durationMs: number): T | null {
  const drops = [...w.detector.onsets].sort((a, b) => a - b);
  if (drops.length < 2 || drops.length > 3) return null;
  const gaps = drops.slice(1).map((t, i) => t - drops[i]);
  if (gaps.some((g) => g < 1000)) return null;
  if (gaps.length === 2 && Math.max(...gaps) / Math.min(...gaps) > 1.6) return null;
  const interval = (drops[drops.length - 1] - drops[0]) / gaps.length;
  return {
    ...w,
    m: {
      ...w.m,
      drops: drops.length,
      dropsPerMin: 60000 / interval,
      intervalMs: interval,
      confidence: "medium",
      rough: true,
      reason: null,
      durationMs,
    },
  };
}

function grayFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, w: number, h: number) {
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let k = 0; k < gray.length; k++) gray[k] = (data[k * 4] * 77 + data[k * 4 + 1] * 150 + data[k * 4 + 2] * 29) >> 8;
  return gray;
}

function seekTo(video: HTMLVideoElement, t: number) {
  return new Promise<void>((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) return resolve();
    const timer = window.setTimeout(resolve, 2000);
    video.addEventListener(
      "seeked",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    video.currentTime = t;
  });
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

type OnFrame = (ctx: CanvasRenderingContext2D, t: number) => void;

/**
 * plays the video (muted) and reads every frame as it is shown. much quicker
 * than seeking frame by frame, which makes the browser decode from the last
 * keyframe every time (minutes for a phone video). where the browser can say
 * when each frame is shown, the speed adapts: as fast as it can while still
 * reading every frame. elsewhere frames are read as the screen redraws.
 */
async function playThrough(video: FrameVideo, seconds: number, onFrame: OnFrame, ctx: CanvasRenderingContext2D, onProgress: (share: number) => void, deadline: number) {
  await seekTo(video, 0);
  video.muted = true;
  video.playbackRate = 1;
  const exact = !!video.requestVideoFrameCallback;
  let frames = 0;
  // how far apart the video's frames are, and whether any were skipped lately
  let frameGap = Infinity;
  let lastMedia = -1;
  let skipped = 0;
  let clean = 0;
  let outOfTime = false;
  await new Promise<void>((resolve, reject) => {
    let last = performance.now();
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      window.clearInterval(watchdog);
      video.removeEventListener("ended", onEnded);
      video.pause();
      if (error) reject(error);
      else resolve();
    };
    const onEnded = () => finish();
    const watchdog = window.setInterval(() => {
      // taking too long: stop and use what has been read
      if (performance.now() > deadline) {
        outOfTime = true;
        return finish();
      }
      // playback stalled (or the browser refused to play): fall back to seeking
      if (performance.now() - last > 4000) finish(new Error("playback stalled"));
    }, 500);
    const handle = (mediaTime: number) => {
      last = performance.now();
      if (mediaTime > seconds) return finish();
      onFrame(ctx, mediaTime * 1000);
      frames++;
      const gap = lastMedia >= 0 ? (mediaTime - lastMedia) * 1000 : NaN;
      if (gap > 0) frameGap = Math.min(frameGap, gap);
      lastMedia = mediaTime;
      onProgress(Math.min(1, mediaTime / seconds));
      if (!exact) return;
      // every frame matters for small, fast drops: slow down as soon as frames are
      // skipped, and speed up only after a long run without any
      if (gap > frameGap * 1.5) {
        clean = 0;
        if (++skipped >= 2) {
          skipped = 0;
          video.playbackRate = Math.max(MIN_PLAY_RATE, video.playbackRate - 0.25);
        }
      } else if (++clean >= 45) {
        clean = 0;
        skipped = 0;
        video.playbackRate = Math.min(MAX_PLAY_RATE, video.playbackRate + 0.25);
      }
    };
    if (exact) {
      const step = (_now: number, meta: { mediaTime: number }) => {
        if (finished) return;
        handle(meta.mediaTime);
        if (!finished) video.requestVideoFrameCallback!(step);
      };
      video.requestVideoFrameCallback!(step);
    } else {
      // no frame callbacks: look at the video every time the screen redraws
      let seen = -1;
      const tick = () => {
        if (finished) return;
        const t = video.currentTime;
        if (t !== seen && !video.paused) {
          seen = t;
          handle(t);
        }
        if (!finished) window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    }
    video.addEventListener("ended", onEnded);
    video.play().catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
  video.playbackRate = 1;
  // too few frames came through to trust (a very slow device): seek instead
  if (!outOfTime && frames < seconds * 8) throw new Error("too few frames");
}

/** frames a second read when seeking, the slow way that works everywhere */
const SEEK_FPS = 15;

/** steps through the video a frame at a time (slow, but works everywhere), until the deadline */
async function seekThrough(video: HTMLVideoElement, seconds: number, onFrame: OnFrame, ctx: CanvasRenderingContext2D, onProgress: (share: number) => void, deadline: number) {
  video.pause();
  const frames = Math.floor(seconds * SEEK_FPS);
  for (let i = 0; i < frames && performance.now() < deadline; i++) {
    await seekTo(video, (i + 0.5) / SEEK_FPS);
    onFrame(ctx, ((i + 0.5) * 1000) / SEEK_FPS);
    if (i % 5 === 0) onProgress(i / frames);
  }
}

/**
 * drops (or a stream) seen in the video. the drip is searched for across the
 * whole picture; tapColumn (0–1 across) is where the user says it is.
 */
export async function analyzePicture(
  video: HTMLVideoElement,
  tapColumn: number,
  onProgress: (share: number) => void,
  /** length in seconds, when the file itself doesn't say (fresh browser recordings) */
  knownSeconds?: number,
): Promise<PictureResult | null> {
  const seconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : knownSeconds;
  if (!video.videoWidth || !seconds) return null;
  const H = Math.round((WIDTH * video.videoHeight) / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // a phone may be slow: never take more than this, and use what was read by then
  const deadline = performance.now() + Math.max(MIN_ANALYSIS_MS, seconds * 1000 * ANALYSIS_TIME_SHARE);
  let search = new ColumnSearch(WIDTH, H, tapColumn);
  const onFrame = (c: CanvasRenderingContext2D, t: number) => search.push(grayFrame(c, video, WIDTH, H), t);
  try {
    await playThrough(video, seconds, onFrame, ctx, onProgress, deadline);
  } catch {
    search = new ColumnSearch(WIDTH, H, tapColumn);
    await seekThrough(video, seconds, onFrame, ctx, onProgress, deadline);
  }
  onProgress(1);
  void seekTo(video, 0);
  return search.result(seconds * 1000);
}

/**
 * sound and picture together. either may be missing (a silent video, or a
 * sound file): the other then decides alone.
 */
export function combine(sound: SoundResult | null, picture: PictureResult | null, durationMs: number): RecordingResult["combined"] {
  if (!sound && !picture) return null;
  // the sound ticking to a clear drip rhythm means a fast drip, even if it looks like a stream
  const soundDrip = !!sound && sound.measurement.confidence === "high" && !sound.steady;
  const stream = fuseStream(picture?.isStream ?? false, sound?.steady ?? false, !sound, soundDrip);
  if (stream.stream) return { measurement: null, stream };
  const given = {
    sound: sound?.measurement,
    // a column judged a stream has no drip of its own to offer
    picture: picture && !picture.isStream ? picture.measurement : undefined,
    noSound: !sound,
    noPicture: !picture,
  };
  return { measurement: fuse(picture?.seen ?? [], sound?.heard ?? [], durationMs, given), stream };
}
