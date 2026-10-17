import { useRef, useState, type ReactNode } from "react";
import {
  analyze,
  FIX_HORIZON_DAYS,
  formatDuration,
  formatMoney,
  formatRate,
  formatVolume,
  LITERS_PER_GAL,
  litersPerDay,
  PERIODS,
  type Measurement,
  type Source,
  type Unit,
} from "@/lib/drips";
import { CAMERA_DETECTOR, CAMERA_ROI, cameraSampler, MIC_DETECTOR, micSampler } from "@/lib/samplers";
import { useDropSession } from "@/lib/useDropSession";
import { BottleSimulation } from "@/BottleSimulation";

type Mode = "idle" | "mic" | "camera" | "tap";
type RepairKind = "diy" | "plumber";

const SOURCE_LABEL: Record<Source, string> = { mic: "sound", camera: "camera", tap: "taps" };

function errorText(e: unknown) {
  if (e instanceof DOMException && e.name === "NotAllowedError") return "access was blocked";
  if (e instanceof DOMException && e.name === "NotFoundError") return "no device found";
  return e instanceof Error ? e.message.toLowerCase() : "something went wrong";
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("idle");
  const [result, setResult] = useState<Measurement | null>(null);
  const [useEstimate, setUseEstimate] = useState(false);
  const [failure, setFailure] = useState<{ source: Source; message: string } | null>(null);
  const [taps, setTaps] = useState<number[]>([]);

  const [unit, setUnit] = useState<Unit>("gal");
  const [price, setPrice] = useState("0.01");
  const [repairKind, setRepairKind] = useState<RepairKind>("diy");
  const [repairCosts, setRepairCosts] = useState<Record<RepairKind, string>>({ diy: "15", plumber: "200" });

  const videoRef = useRef<HTMLVideoElement>(null);

  const session = useDropSession({
    minMs: 30000,
    maxMs: 90000,
    minDrops: 6,
    onDone: (source, onsets, durationMs) => {
      setMode("idle");
      setResult(analyze(source, onsets, durationMs));
    },
  });

  function reset(next: Mode) {
    session.cancel();
    setResult(null);
    setUseEstimate(false);
    setFailure(null);
    setMode(next);
  }

  async function listen() {
    reset("mic");
    try {
      session.start(await micSampler(), "mic", MIC_DETECTOR);
    } catch (e) {
      setMode("idle");
      setFailure({ source: "mic", message: `microphone unavailable: ${errorText(e)}` });
    }
  }

  async function watch() {
    reset("camera");
    try {
      session.start(await cameraSampler(videoRef.current!), "camera", CAMERA_DETECTOR);
    } catch (e) {
      setMode("idle");
      setFailure({ source: "camera", message: `camera unavailable: ${errorText(e)}` });
    }
  }

  function startTapping() {
    reset("tap");
    setTaps([]);
  }

  function finishTapping() {
    const t0 = taps[0] ?? 0;
    setResult(analyze("tap", taps.map((t) => t - t0), taps.length ? taps[taps.length - 1] - t0 : 0));
    setMode("idle");
  }

  function stopEarly() {
    session.finish();
  }

  function cancel() {
    reset("idle");
  }

  function switchUnit(next: Unit) {
    if (next === unit) return;
    const p = parseFloat(price);
    if (Number.isFinite(p)) {
      const converted = next === "l" ? p / LITERS_PER_GAL : p * LITERS_PER_GAL;
      setPrice(String(Number(converted.toPrecision(3))));
    }
    setUnit(next);
  }

  const lowResult = result && result.confidence === "low" ? result : null;
  const fallbackFrom: Source | null = mode !== "idle" ? null : (failure?.source ?? (lowResult && !useEstimate ? lowResult.source : null));
  const measured = result && result.dropsPerMin !== null && (result.confidence !== "low" || useEstimate) ? result : null;

  // cost math
  const dpm = measured?.dropsPerMin ?? 0;
  const lpd = litersPerDay(dpm);
  const priceNum = Math.max(0, parseFloat(price) || 0);
  const pricePerLiter = unit === "gal" ? priceNum / LITERS_PER_GAL : priceNum;
  const costPerDay = lpd * pricePerLiter;
  const repair = Math.max(0, parseFloat(repairCosts[repairKind]) || 0);
  const breakEvenDays = costPerDay > 0 ? repair / costPerDay : Infinity;
  const shouldFix = breakEvenDays <= FIX_HORIZON_DAYS;

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <main className="mx-auto max-w-xl px-4 py-8 sm:py-12">
        <header className="flex items-baseline justify-between border-b border-neutral-900 pb-3">
          <h1 className="text-base font-medium">drippy</h1>
          <span className="text-xs text-neutral-500">drip cost analyzer</span>
        </header>

        <Section n="01" title="measure">
          {mode === "idle" && !fallbackFrom && (
            <>
              <p className="text-sm text-neutral-600">
                hold your mic close to where the drops land and keep the room quiet. drippy listens for 30 seconds, longer
                for slow drips.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button primary onClick={listen}>
                  {result ? "listen again" : "start listening"}
                </Button>
                <Button onClick={watch}>use camera</Button>
                <Button onClick={startTapping}>tap manually</Button>
              </div>
            </>
          )}

          {fallbackFrom && (
            <Fallback
              from={fallbackFrom}
              blocked={failure !== null}
              message={failure?.message ?? lowResult?.reason ?? ""}
              estimate={lowResult?.dropsPerMin ?? null}
              onCamera={watch}
              onListen={listen}
              onTap={startTapping}
              onUseEstimate={() => setUseEstimate(true)}
            />
          )}

          <div className={mode === "camera" ? "relative mb-3" : "hidden"}>
            <video ref={videoRef} playsInline muted className="block h-auto w-full bg-neutral-100" />
            <div
              className="absolute inset-y-0 border-x border-dashed border-blue-600"
              style={{ left: `${CAMERA_ROI.left * 100}%`, width: `${CAMERA_ROI.width * 100}%` }}
            />
          </div>

          {(mode === "mic" || mode === "camera") && (
            <>
              <canvas ref={session.canvasRef} className="block h-20 w-full border border-neutral-200" />
              <div className="mt-3 flex items-baseline justify-between text-sm">
                <span>
                  {session.drops} drop{session.drops === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums text-neutral-500">{clock(session.elapsed)}</span>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                {mode === "mic"
                  ? "listening. each blue tick is a drop. stops on its own once it has enough."
                  : "keep the falling drops inside the dashed strip and hold still. each blue tick is a drop."}
              </p>
              <div className="mt-4 flex gap-2">
                <Button primary onClick={stopEarly}>
                  stop
                </Button>
                <Button onClick={cancel}>cancel</Button>
              </div>
            </>
          )}

          {mode === "tap" && (
            <>
              <p className="text-sm text-neutral-600">tap the button each time a drop lands. 6 or more taps works best.</p>
              <button
                type="button"
                onPointerDown={() => setTaps((t) => [...t, performance.now()])}
                className="mt-4 h-32 w-full touch-manipulation select-none border border-neutral-900 text-sm active:bg-neutral-900 active:text-white"
              >
                tap
              </button>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm">
                  {taps.length} tap{taps.length === 1 ? "" : "s"}
                </span>
                <div className="flex gap-2">
                  <Button primary onClick={finishTapping} disabled={taps.length < 3}>
                    done
                  </Button>
                  <Button onClick={cancel}>cancel</Button>
                </div>
              </div>
            </>
          )}
        </Section>

        {measured && (
          <>
            <Section n="02" title="rate">
              <div className="flex items-baseline gap-2">
                <span className="text-4xl tabular-nums text-blue-600">{formatRate(dpm)}</span>
                <span className="text-sm">drops / min</span>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                one drop every {((measured.intervalMs ?? 0) / 1000).toFixed(1)} s · {measured.confidence} confidence ·{" "}
                {measured.drops} drops in {Math.round(measured.durationMs / 1000)} s from {SOURCE_LABEL[measured.source]}
              </p>
              <BottleSimulation dropsPerMin={dpm} intervalMs={measured.intervalMs ?? 60000 / dpm} litersPerDay={lpd} />
            </Section>

            <Section n="03" title="cost">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="text-neutral-500">water price</span>
                <span className="flex items-baseline">
                  $<NumberInput value={price} onChange={setPrice} step="0.001" label="water price" />
                </span>
                <span className="text-neutral-500">per</span>
                <Toggle options={["gal", "l"] as const} value={unit} onChange={switchUnit} />
              </div>
              <table className="mt-4 w-full text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500">
                    <th className="py-2 font-normal">per</th>
                    <th className="py-2 text-right font-normal">water</th>
                    <th className="py-2 text-right font-normal">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map(([label, days]) => (
                    <tr key={label} className="border-b border-neutral-100">
                      <td className="py-2">{label}</td>
                      <td className="py-2 text-right">{formatVolume(lpd * days, unit)}</td>
                      <td className="py-2 text-right">{formatMoney(costPerDay * days)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-neutral-500">assumes 0.25 ml per drop.</p>
            </Section>

            <Section n="04" title="break-even">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="text-neutral-500">repair</span>
                <Toggle options={["diy", "plumber"] as const} value={repairKind} onChange={setRepairKind} />
                <span className="flex items-baseline">
                  $
                  <NumberInput
                    value={repairCosts[repairKind]}
                    onChange={(v) => setRepairCosts((c) => ({ ...c, [repairKind]: v }))}
                    step="1"
                    label="repair cost"
                  />
                </span>
              </div>
              {costPerDay > 0 ? (
                <>
                  <p className="mt-4 text-sm">
                    the leak costs more than the repair after <span className="text-blue-600">{formatDuration(breakEvenDays)}</span>.
                  </p>
                  <div className="mt-4">
                    <div className="relative h-2 bg-neutral-100">
                      <div
                        className={`absolute inset-y-0 left-0 ${shouldFix ? "bg-blue-600" : "bg-neutral-300"}`}
                        style={{ width: `${Math.min(1, breakEvenDays / FIX_HORIZON_DAYS) * 100}%` }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-xs text-neutral-500">
                      <span>today</span>
                      <span>{shouldFix ? "" : "beyond "}1 year</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="mt-4 text-sm">at this water price the leak costs nothing, so it never outprices the repair.</p>
              )}
            </Section>

            <Section n="05" title="verdict">
              <p className="text-2xl">{shouldFix ? "fix it" : "leave it"}</p>
              <p className="mt-2 text-sm text-neutral-600">
                {shouldFix
                  ? `a ${formatMoney(repair)} ${repairKind === "diy" ? "diy repair" : "plumber visit"} pays for itself in ${formatDuration(breakEvenDays)}. left alone, this drip costs about ${formatMoney(costPerDay * 365)} a year.`
                  : `this drip costs about ${formatMoney(costPerDay * 365)} a year, so a ${formatMoney(repair)} ${repairKind === "diy" ? "diy repair" : "plumber visit"} wouldn't pay for itself within a year. measure again in a month, since drips tend to get worse.`}
              </p>
              {measured.confidence === "low" && (
                <p className="mt-2 text-xs text-neutral-500">based on a low-confidence estimate.</p>
              )}
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="border-b border-neutral-200 py-6">
      <h2 className="mb-4 text-xs text-neutral-500">
        {n} · {title}
      </h2>
      {children}
    </section>
  );
}

function Button({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm transition-colors disabled:opacity-30 ${
        primary
          ? "bg-neutral-900 text-white hover:bg-neutral-700"
          : "border border-neutral-300 hover:border-neutral-900"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <span className="inline-flex border border-neutral-300">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`px-2 py-0.5 text-sm ${o === value ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"}`}
        >
          {o}
        </button>
      ))}
    </span>
  );
}

function NumberInput({
  value,
  onChange,
  step,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  step: string;
  label: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step={step}
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="w-20 border-b border-neutral-300 bg-transparent py-0.5 pl-1 text-sm tabular-nums focus:border-neutral-900 focus:outline-none"
    />
  );
}

function Fallback({
  from,
  blocked,
  message,
  estimate,
  onCamera,
  onListen,
  onTap,
  onUseEstimate,
}: {
  from: Source;
  /** the device couldn't be opened at all, rather than giving an unclear reading */
  blocked: boolean;
  message: string;
  estimate: number | null;
  onCamera: () => void;
  onListen: () => void;
  onTap: () => void;
  onUseEstimate: () => void;
}) {
  const text = blocked
    ? `${message}. ${from === "mic" ? "the camera can watch the drops instead." : "you can tap along with the drops instead."}`
    : from === "mic"
      ? `couldn't count drops reliably from sound (${message}). the camera can watch the drops instead.`
      : from === "camera"
        ? `couldn't see drops clearly (${message}). try more light and a closer view, or tap along with the drops.`
        : `couldn't get a steady rhythm from your taps (${message}).`;

  return (
    <div className="border border-neutral-900 p-4">
      <p className="text-sm">{text}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {from === "mic" && (
          <>
            <Button primary onClick={onCamera}>
              allow camera
            </Button>
            <Button onClick={onListen}>listen again</Button>
            <Button onClick={onTap}>tap manually</Button>
          </>
        )}
        {from === "camera" && (
          <>
            <Button primary onClick={onTap}>
              tap manually
            </Button>
            <Button onClick={onCamera}>try camera again</Button>
            <Button onClick={onListen}>listen again</Button>
          </>
        )}
        {from === "tap" && (
          <>
            <Button primary onClick={onTap}>
              tap again
            </Button>
            <Button onClick={onListen}>listen instead</Button>
          </>
        )}
      </div>
      {estimate !== null && (
        <button type="button" onClick={onUseEstimate} className="mt-3 text-xs text-neutral-500 underline hover:text-neutral-900">
          use the rough estimate anyway ({formatRate(estimate)} drops / min)
        </button>
      )}
    </div>
  );
}
