import { useEffect, useRef, useState, type MouseEvent } from "react";
import { formatRate, type Measurement } from "@/lib/drips";
import { analyzePicture, analyzeSound, type RecordingResult } from "@/lib/recording";
import { COLUMN_HALF_WIDTH } from "@/lib/samplers";

type Phase = "pick" | "aim" | "checking" | "done";

function describe(m: Measurement | null) {
  if (!m) return "nothing to check";
  if (m.dropsPerMin === null || m.confidence === "low") return `no steady drip found (${m.reason ?? "unclear"})`;
  return `${m.drops} drops · ${formatRate(m.dropsPerMin)} / min · ${m.confidence} confidence`;
}

/** checks a saved video or audio file with the same detectors used live */
export function RecordingTester({
  onUse,
  onStream,
  onCancel,
}: {
  onUse: (m: Measurement) => void;
  onStream: () => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [column, setColumn] = useState(0.5);
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState("");
  const [result, setResult] = useState<RecordingResult>({ sound: null, picture: null });

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  function choose(f: File | undefined) {
    if (!f) return;
    if (url) URL.revokeObjectURL(url);
    setFile(f);
    setUrl(URL.createObjectURL(f));
    setResult({ sound: null, picture: null });
    setPhase("aim");
  }

  async function check(col: number | null) {
    if (!file) return;
    setPhase("checking");
    setStep("checking the sound…");
    setProgress(0);
    const sound = await analyzeSound(file);
    let picture: RecordingResult["picture"] = null;
    if (col !== null && videoRef.current) {
      setStep("checking the picture, frame by frame…");
      picture = await analyzePicture(videoRef.current, col, setProgress);
    }
    setResult({ sound, picture });
    setPhase("done");
  }

  function onLoaded() {
    const v = videoRef.current;
    if (!v) return;
    if (!v.videoWidth) {
      // audio only: nothing to aim at
      void check(null);
    } else {
      v.currentTime = 0.05;
    }
  }

  function aimAt(e: MouseEvent<HTMLDivElement>) {
    if (phase !== "aim") return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
    setColumn(x);
    void check(x);
  }

  const { sound, picture } = result;
  const usable = (m: Measurement | null | undefined) => !!m && m.dropsPerMin !== null && m.confidence !== "low";

  return (
    <div>
      {phase === "pick" && (
        <>
          <p className="text-sm text-water-ink/80">
            pick a video or audio file of the drip. drippy checks its sound and its picture with the same detectors it
            uses live, so you can see exactly what it counts. 10–30 seconds is plenty.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <label className="cursor-pointer rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink">
              choose a file
              <input
                type="file"
                accept="video/*,audio/*"
                className="hidden"
                onChange={(e) => choose(e.target.files?.[0])}
              />
            </label>
            <button type="button" onClick={onCancel} className="rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky">
              cancel
            </button>
          </div>
        </>
      )}

      {url && (
        <div
          className={phase === "aim" || phase === "checking" ? `relative mb-3 ${phase === "aim" ? "cursor-crosshair" : ""}` : "hidden"}
          onClick={aimAt}
        >
          <video ref={videoRef} src={url} muted playsInline preload="auto" onLoadedData={onLoaded} className="block h-auto w-full bg-sky" />
          {phase === "aim" ? (
            <div className="absolute inset-x-0 top-0 bg-white/90 p-2 text-center text-sm">tap the picture where the drops fall</div>
          ) : (
            <div
              className="absolute inset-y-0 border-x border-water-deep bg-water/20"
              style={{ left: `${(column - COLUMN_HALF_WIDTH) * 100}%`, width: `${COLUMN_HALF_WIDTH * 2 * 100}%` }}
            />
          )}
        </div>
      )}

      {phase === "aim" && (
        <div className="flex gap-2">
          <button type="button" onClick={() => void check(null)} className="rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky">
            sound only
          </button>
          <button type="button" onClick={onCancel} className="rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky">
            cancel
          </button>
        </div>
      )}

      {phase === "checking" && (
        <div>
          <p className="text-sm">{step}</p>
          <div className="mt-2 h-1 bg-sky">
            <div className="h-full bg-water" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="space-y-4">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-water-light/50">
                <td className="py-2 pr-3 text-water-deep">sound</td>
                <td className="py-2">{describe(sound)}</td>
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
            if the sound and picture disagree, the clip's sound may have been added separately; trust the one that matches
            what you see.
          </p>
          <div className="flex flex-wrap gap-2">
            {usable(sound) && (
              <button type="button" onClick={() => onUse(sound!)} className="rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink">
                use the sound result
              </button>
            )}
            {picture && !picture.isStream && usable(picture.measurement) && (
              <button
                type="button"
                onClick={() => onUse(picture.measurement)}
                className="rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink"
              >
                use the picture result
              </button>
            )}
            {picture?.isStream && (
              <button type="button" onClick={onStream} className="rounded-full border-[3px] border-water-deep bg-water-deep px-5 py-2 text-sm font-medium text-white hover:bg-water-ink">
                measure the stream
              </button>
            )}
            <button
              type="button"
              onClick={() => setPhase("pick")}
              className="rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky"
            >
              try another file
            </button>
            <button type="button" onClick={onCancel} className="rounded-full border-[3px] border-water-deep bg-white px-5 py-2 text-sm font-medium text-water-deep hover:bg-sky">
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
