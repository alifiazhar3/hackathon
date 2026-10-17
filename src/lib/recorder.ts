/**
 * records a short video (picture and sound together) in the browser, so it
 * can be analyzed frame by frame and sample by sample like an uploaded video.
 * a recording keeps sound and picture in sync, so nothing needs lining up live.
 */

/** a recording must be at least this long to find a steady rhythm... */
export const MIN_SECONDS = 10;
/** ...and recording stops on its own here */
export const MAX_SECONDS = 30;

/** a message if a clip is too short or too long, otherwise null */
export function lengthProblem(seconds: number, kind: "recording" | "video") {
  if (!Number.isFinite(seconds) || seconds <= 0) return `couldn't tell how long this ${kind} is`;
  const s = Math.round(seconds * 10) / 10;
  if (seconds < MIN_SECONDS) return `this ${kind} is only ${s} seconds long`;
  if (seconds > MAX_SECONDS + 0.5) return `this ${kind} is ${s} seconds long, more than ${MAX_SECONDS}`;
  return null;
}

/** opens the back camera and the microphone and shows the camera in the video element */
export async function openCameraAndMic(video: HTMLVideoElement) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
    // raw sound: noise suppression and echo cancellation would erase quiet plinks
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return {
    stream,
    close() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

function pickMimeType() {
  const options = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return options.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

/** starts recording the stream; stop() resolves with the video file */
export function startRecording(stream: MediaStream) {
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" }));
  });
  recorder.start(1000);
  const startedAt = performance.now();
  return {
    startedAt,
    stop() {
      if (recorder.state !== "inactive") recorder.stop();
      return done;
    },
  };
}

/**
 * recorded webm files often report an unknown (infinite) length until the
 * browser has looked through them; this forces it to work it out
 */
export async function ensureDuration(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration)) return video.duration;
  await new Promise<void>((resolve) => {
    const done = () => {
      video.removeEventListener("durationchange", check);
      resolve();
    };
    const check = () => {
      if (Number.isFinite(video.duration)) done();
    };
    video.addEventListener("durationchange", check);
    video.currentTime = 1e7;
    window.setTimeout(done, 3000);
  });
  video.currentTime = 0;
  await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
  return video.duration;
}
