import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { Measurement } from "@/lib/drips";
import { lengthProblem, ensureDuration, MAX_SECONDS, MIN_SECONDS } from "@/lib/recorder";
import { analyzePicture, analyzeSound, combine, type RecordingResult } from "@/lib/recording";
import { COLUMN_HALF_WIDTH } from "@/lib/samplers";

type Phase = "pick" | "loading" | "wrong-length" | "aim" | "checking" | "done";

/** a clip recorded in the browser, already aimed */
export type Recorded = { blob: Blob; column: number; seconds: number };

const PRIMARY = "rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink";
const SECONDARY = "rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky";

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

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  function choose(f: File | undefined) {
    if (!f) return;
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setResult({ sound: null, picture: null, combined: null });
    setProblem("");
    setPhase("loading");
  }

  async function check(col: number | null, length: number) {
    if (!file) return;
    setPhase("checking");
    setStep("checking the sound…");
    setProgress(0);
    const sound = await analyzeSound(file);
    let picture: RecordingResult["picture"] = null;
    if (col !== null && videoRef.current) {
      setStep("checking the picture, frame by frame…");
      picture = await analyzePicture(videoRef.current, col, setProgress, length);
    }
    const combined = combine(sound, picture, length * 1000);
    setResult({ sound, picture, combined });

    // camera and mic together give one answer, which goes straight to the results
    if (combined?.stream.stream) return onStream(combined.stream.note);
    if (usable(combined?.measurement)) return onUse(combined.measurement);
    setPhase("done");
  }

  async function onLoaded() {
    const v = videoRef.current;
    if (!v) return;
    const known = await ensureDuration(v);
    const length = Number.isFinite(known) ? known : (recorded?.seconds ?? NaN);
    setSeconds(length);
    const issue = lengthProblem(length, recorded ? "recording" : "video");
    if (issue) {
      setProblem(issue);
      setPhase("wrong-length");
      return;
    }
    if (recorded) return void check(recorded.column, length);
    if (!v.videoWidth) return void check(null, length); // audio only: nothing to aim at
    v.currentTime = 0.05;
    setPhase("aim");
  }

  function aimAt(e: MouseEvent<HTMLDivElement>) {
    if (phase !== "aim") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
    setColumn(x);
    void check(x, seconds);
  }

  const { picture, combined } = result;

  return (
    <div>
      {phase === "pick" && (
        <>
          <p className="text-sm text-water-ink/80">
            pick a {MIN_SECONDS}–{MAX_SECONDS} second video of the drip, filmed with sound. drippy checks every frame and
            every sound, then combines them.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <label className={`cursor-pointer ${PRIMARY}`}>
              choose a video
              <input type="file" accept="video/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
            </label>
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
            <label className={`cursor-pointer ${SECONDARY}`}>
              upload another video
              <input type="file" accept="video/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
            </label>
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
              : "hidden"
          }
          onClick={aimAt}
        >
          <video ref={videoRef} src={url} muted playsInline preload="auto" onLoadedData={() => void onLoaded()} className="block h-auto w-full bg-sky" />
          {phase === "aim" ? (
            <div className="absolute inset-x-0 top-0 bg-white/90 p-2 text-center text-sm font-medium text-water-deep">
              tap the picture where the drops fall
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
          <p className="mt-1 text-sm">
            {!picture
              ? "it needs a video with sound, so the camera and the mic can check each other."
              : (combined?.measurement?.reason ?? "the camera and the mic didn't find the same steady drip") + "."}
          </p>
          <p className="mt-2 text-xs text-water-deep">
            tips: prop the phone up so it doesn't move, keep the falling drops in view and tap right where they fall, get close
            enough to hear them land, and keep the room quiet.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onRecord} className={PRIMARY}>
              record again
            </button>
            <label className={`cursor-pointer ${SECONDARY}`}>
              upload another video
              <input type="file" accept="video/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
            </label>
            <button type="button" onClick={onCancel} className={SECONDARY}>
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
