import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import type { Measurement } from "@/lib/drips";
import { lengthProblem, ensureDuration, MAX_SECONDS, MIN_SECONDS } from "@/lib/recorder";
import { analyzePicture, analyzeSound, combine, type RecordingResult } from "@/lib/recording";
import { COLUMN_HALF_WIDTH } from "@/lib/samplers";

type Phase = "pick" | "loading" | "wrong-length" | "aim" | "checking" | "done";

/** a clip recorded in the browser, already aimed */
export type Recorded = { blob: Blob; column: number; seconds: number };

const PRIMARY = "rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink";
const SECONDARY = "rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky";
/** phones label videos inconsistently, so name the common kinds as well */
const VIDEO_TYPES = "video/*,.mp4,.mov,.m4v,.webm,.3gp";
/** give up on a video the browser can't open after this long */
const LOAD_TIMEOUT_MS = 20_000;

const usable = (m: Measurement | null | undefined): m is Measurement => !!m && m.dropsPerMin !== null && m.confidence !== "low";

/**
 * analyzes a 10–30 second video, uploaded or recorded in the browser, with the
 * same detectors as before: every frame and every sound sample, then both
 * combined. a fresh recording is analyzed and used automatically.
 */
export function RecordingTester({
  recorded,
  onUse,
  onStream,
  onRecord,
  onCancel,
}: {
  recorded?: Recorded | null;
  onUse: (m: Measurement) => void;
  onStream: (note?: string) => void;
  onRecord: () => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [file, setFile] = useState<Blob | null>(recorded?.blob ?? null);
  const [url, setUrl] = useState<string | null>(() => (recorded ? URL.createObjectURL(recorded.blob) : null));
  const [phase, setPhase] = useState<Phase>(recorded ? "loading" : "pick");
  const [column, setColumn] = useState(recorded?.column ?? 0.5);
  const [seconds, setSeconds] = useState(recorded?.seconds ?? 0);
  const [problem, setProblem] = useState("");
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState("");
  const [result, setResult] = useState<RecordingResult>({ sound: null, picture: null, combined: null });
  /** loading has finished (or failed), so later events from the same video are ignored */
  const loaded = useRef(false);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  // a video the browser can't open may never say so: don't wait forever
  useEffect(() => {
    if (phase !== "loading") return;
    const timer = window.setTimeout(() => {
      if (loaded.current) return;
      loaded.current = true;
      setProblem("this video couldn't be opened in this browser");
      setPhase("done");
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase, url]);

  function choose(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    // clear the picker, so choosing the same file again still counts as a choice
    e.target.value = "";
    if (!f) return;
    if (url) URL.revokeObjectURL(url);
    loaded.current = false;
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setResult({ sound: null, picture: null, combined: null });
    setProblem("");
    setPhase("loading");
  }

  async function check(col: number, length: number) {
    if (!file) return;
    setPhase("checking");
    setProgress(0);
    try {
      // sound and picture are read at the same time, so a slow sound track doesn't hold up the picture
      const listening = analyzeSound(file);
      const v = videoRef.current;
      let picture: RecordingResult["picture"] = null;
      if (v && v.videoWidth) {
        setStep("watching the video for drops…");
        picture = await analyzePicture(v, col, setProgress, length);
      }
      setStep("listening to the sound…");
      const sound = await listening;
      const combined = combine(sound, picture, length * 1000);
      setResult({ sound, picture, combined });
      if (picture) setColumn(picture.column);

      // camera and mic together give one answer, which goes straight to the results
      if (combined?.stream.stream) return onStream(combined.stream.note);
      if (usable(combined?.measurement)) return onUse(combined.measurement);
    } catch (e) {
      setProblem(`something went wrong while checking the video (${e instanceof Error ? e.message.toLowerCase() : "unknown error"})`);
    }
    setPhase("done");
  }

  async function onLoaded() {
    const v = videoRef.current;
    if (!v || loaded.current) return;
    loaded.current = true;
    const known = await ensureDuration(v);
    const length = Number.isFinite(known) && known > 0 ? known : (recorded?.seconds ?? NaN);
    setSeconds(length);
    const issue = lengthProblem(length, recorded ? "recording" : "video");
    if (issue) {
      setProblem(issue);
      setPhase("wrong-length");
      return;
    }
    if (recorded) return void check(recorded.column, length);
    // nothing to aim at (a sound-only file): go straight to listening
    if (!v.videoWidth) return void check(0.5, length);
    v.currentTime = Math.min(1, length / 2);
    setPhase("aim");
  }

  function onVideoError() {
    if (loaded.current) return;
    loaded.current = true;
    setProblem("this video couldn't be opened in this browser");
    setPhase("done");
  }

  function aimAt(e: MouseEvent<HTMLDivElement>) {
    if (phase !== "aim") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
    setColumn(x);
    // start playing right away, inside the tap: phones (iphones in low power mode
    // especially) only let a video play when a tap starts it
    const v = videoRef.current;
    if (v) {
      v.muted = true;
      // the frame reader takes it from here (back to the start, then plays on)
      void v.play()?.catch(() => {});
    }
    void check(x, seconds);
  }

  const picker = (label: string, style: string) => (
    <label className={`cursor-pointer ${style}`}>
      {label}
      <input type="file" accept={VIDEO_TYPES} className="sr-only" onChange={choose} />
    </label>
  );

  const { sound, picture, combined } = result;
  const reason = problem
    ? problem
    : !picture && !sound
      ? "drippy couldn't read any picture or sound from it"
      : (combined?.measurement?.reason ?? "no steady drip was found");

  return (
    <div>
      {phase === "pick" && (
        <>
          <p className="text-sm text-water-ink/80">
            pick a {MIN_SECONDS}–{MAX_SECONDS} second video of the leak. drippy watches every frame (and listens, if it has
            sound), then works out how fast it drips, or whether it's a stream.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {picker("choose a video", PRIMARY)}
            <button type="button" onClick={onCancel} className={SECONDARY}>
              cancel
            </button>
          </div>
        </>
      )}

      {phase === "loading" && <p className="text-sm">getting the {recorded ? "recording" : "video"} ready…</p>}

      {phase === "wrong-length" && (
        <div className="rounded-2xl border-[3px] border-coral bg-coral-light p-4">
          <p className="text-sm font-semibold text-coral-deep">{problem}.</p>
          <p className="mt-1 text-sm">
            please upload a {MIN_SECONDS}–{MAX_SECONDS} second video, or record for {MIN_SECONDS}–{MAX_SECONDS} seconds.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onRecord} className={PRIMARY}>
              record {MIN_SECONDS}–{MAX_SECONDS} s
            </button>
            {picker("upload another video", SECONDARY)}
            <button type="button" onClick={onCancel} className={SECONDARY}>
              cancel
            </button>
          </div>
        </div>
      )}

      {url && (
        <div
          className={
            phase === "aim" || phase === "checking"
              ? `relative mb-3 overflow-hidden rounded-2xl border-[3px] border-water-deep ${phase === "aim" ? "cursor-crosshair" : ""}`
              : // kept on the page (not display: none) so every browser loads it
                "pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
          }
          onClick={aimAt}
        >
          <video
            key={url}
            ref={videoRef}
            src={url}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={() => void onLoaded()}
            onError={onVideoError}
            className="block h-auto w-full bg-sky"
          />
          {phase === "aim" ? (
            <div className="absolute inset-x-0 top-0 bg-white/90 p-2 text-center text-sm font-medium text-water-deep">
              tap the picture where the water falls
            </div>
          ) : (
            <div
              className="absolute inset-y-0 border-x-2 border-water-deep bg-water/20"
              style={{ left: `${(column - COLUMN_HALF_WIDTH) * 100}%`, width: `${COLUMN_HALF_WIDTH * 2 * 100}%` }}
            />
          )}
        </div>
      )}

      {phase === "aim" && (
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className={SECONDARY}>
            cancel
          </button>
        </div>
      )}

      {phase === "checking" && (
        <div>
          <p className="text-sm">{step}</p>
          <div className="mt-2 h-3 overflow-hidden rounded-full border-2 border-water-deep bg-white">
            <div className="h-full bg-water" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="rounded-2xl border-[3px] border-coral bg-coral-light p-4">
          <p className="text-sm font-semibold text-coral-deep">couldn't measure the drip from this {recorded ? "recording" : "video"}.</p>
          <p className="mt-1 text-sm">{reason}.</p>
          <p className="mt-2 text-xs text-water-deep">
            tips: prop the phone up so it doesn't move, keep the falling drops in view and tap right where they fall, and film
            for the full {MAX_SECONDS} seconds if the drip is slow. if the browser can't open the video, try an mp4, or record
            in drippy instead.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onRecord} className={PRIMARY}>
              record again
            </button>
            {picker("upload another video", SECONDARY)}
            <button type="button" onClick={onCancel} className={SECONDARY}>
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
