import { useEffect, useRef, useState, type MouseEvent } from "react";
import { formatRate, type Measurement } from "@/lib/drips";
import { lengthProblem, ensureDuration, MAX_SECONDS, MIN_SECONDS } from "@/lib/recorder";
import { analyzePicture, analyzeSound, combine, type RecordingResult } from "@/lib/recording";
import { COLUMN_HALF_WIDTH } from "@/lib/samplers";

type Phase = "pick" | "loading" | "wrong-length" | "aim" | "checking" | "done";

/** a clip recorded in the browser, already aimed */
export type Recorded = { blob: Blob; column: number; seconds: number };

const PRIMARY = "rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink";
const SECONDARY = "rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky";

function describe(m: Measurement | null) {
  if (!m) return "nothing to check";
  if (m.dropsPerMin === null || m.confidence === "low") return `no steady drip found (${m.reason ?? "unclear"})`;
  return `${m.drops} drops · ${formatRate(m.dropsPerMin)} / min · ${m.confidence} confidence`;
}

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

    // a fresh recording goes straight to the result when it's clear
    if (recorded) {
      if (combined?.stream.stream) return onStream(combined.stream.note);
      if (usable(combined?.measurement)) return onUse(combined.measurement);
    }
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

  const { sound, picture, combined } = result;

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
              <input type="file" accept="video/*,audio/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
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
              <input type="file" accept="video/*,audio/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
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
        <div className="space-y-4">
          <table className="w-full text-sm">
            <tbody>
              {combined && (
                <tr className="border-b border-water-light/50">
                  <td className="py-2 pr-3 font-semibold text-water-deep">camera + mic</td>
                  <td className="py-2 font-semibold">
                    {combined.stream.stream
                      ? `a steady stream (${combined.stream.note})`
                      : combined.measurement
                        ? `${describe(combined.measurement)} · ${combined.measurement.fused.confirmed} seen and heard`
                        : "nothing to check"}
                  </td>
                </tr>
              )}
              <tr className="border-b border-water-light/50">
                <td className="py-2 pr-3 text-water-deep">sound</td>
                <td className="py-2">{describe(sound?.measurement ?? null)}</td>
              </tr>
              <tr className="border-b border-water-light/50">
                <td className="py-2 pr-3 text-water-deep">picture</td>
                <td className="py-2">
                  {picture?.isStream ? "a steady stream, not drops" : picture ? describe(picture.measurement) : "not checked"}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-water-deep">
            camera + mic is the most accurate when the sound and picture were recorded together. if they disagree, check the
            camera is on the tap you can hear, or the clip's sound may have been added separately.
          </p>
          <div className="flex flex-wrap gap-2">
            {usable(combined?.measurement) && (
              <button type="button" onClick={() => onUse(combined!.measurement!)} className={PRIMARY}>
                use camera + mic
              </button>
            )}
            {usable(sound?.measurement) && (
              <button type="button" onClick={() => onUse(sound!.measurement)} className={SECONDARY}>
                use the sound result
              </button>
            )}
            {picture && !picture.isStream && usable(picture.measurement) && (
              <button type="button" onClick={() => onUse(picture.measurement)} className={SECONDARY}>
                use the picture result
              </button>
            )}
            {(picture?.isStream || combined?.stream.stream) && (
              <button type="button" onClick={() => onStream(combined?.stream.note)} className={PRIMARY}>
                measure the stream
              </button>
            )}
            <button type="button" onClick={onRecord} className={SECONDARY}>
              record again
            </button>
            <button type="button" onClick={onCancel} className={SECONDARY}>
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
