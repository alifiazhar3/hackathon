import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  analyze,
  streamMeasurement,
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
import { COLUMN_HALF_WIDTH } from "@/lib/samplers";
import type { Fused } from "@/lib/fusion";
import { lengthProblem, MAX_SECONDS, MIN_SECONDS, openCameraAndMic, startRecording } from "@/lib/recorder";
import { BottleSimulation } from "@/BottleSimulation";
import { RecordingTester, type Recorded } from "@/RecordingTester";
import {
  BottlePic,
  CalendarPic,
  CameraPic,
  CoinsPic,
  DropPic,
  DropsDivider,
  FilmPic,
  FingerPic,
  HappyDropPic,
  HourglassPic,
  MicPic,
  PiggyPic,
  SleepyDropPic,
  SunPic,
  TapPic,
  WrenchPic,
} from "@/Pictures";
import logo from "@/assets/drippy-logo.png";
import {
  breakEvenDays as breakEvenWithGrowth,
  costOfWaiting,
  DRINKING_LITERS_PER_DAY,
  LOCATIONS,
  MONTHLY_GROWTH,
  SHOWER_LITERS,
  urgency,
  WAITS,
  type Location,
  type Urgency,
} from "@/lib/urgency";

type Mode = "idle" | "record" | "tap" | "file";
type RepairKind = "diy" | "plumber";

const SOURCE_LABEL: Record<Source, string> = { mic: "sound", camera: "camera", tap: "taps", both: "camera + mic" };

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
  const [location, setLocation] = useState<Location>("sink");

  const videoRef = useRef<HTMLVideoElement>(null);
  /** turns the camera off while it is open for aiming but not yet counting */
  const closeCameraRef = useRef<(() => void) | null>(null);
  const [aiming, setAiming] = useState(false);
  const [column, setColumn] = useState(0.5);

  // a steady stream is measured by timing how long it takes to fill a container
  const [streamFound, setStreamFound] = useState(false);
  const [cupMl, setCupMl] = useState("473");
  const [cupStartedAt, setCupStartedAt] = useState<number | null>(null);
  /** what camera + mic made of a stream, e.g. "seen and heard as a steady stream" */
  const [streamNote, setStreamNote] = useState("");

  // recording a 10–30 s clip in the browser, then analyzing it like an uploaded video
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<ReturnType<typeof startRecording> | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [tooShort, setTooShort] = useState("");
  const elapsed = recordingSince === null ? 0 : Math.max(0, now - recordingSince) / 1000;

  // tick the timer while recording
  useEffect(() => {
    if (recordingSince === null) return;
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [recordingSince]);

  // stop on our own at the limit
  useEffect(() => {
    if (recordingSince !== null && elapsed >= MAX_SECONDS) void stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed]);

  function closeCamera() {
    closeCameraRef.current?.();
    closeCameraRef.current = null;
  }

  function reset(next: Mode) {
    void recorderRef.current?.stop();
    recorderRef.current = null;
    streamRef.current = null;
    setRecordingSince(null);
    setRecorded(null);
    setTooShort("");
    closeCamera();
    setAiming(false);
    setResult(null);
    setUseEstimate(false);
    setFailure(null);
    setStreamFound(false);
    setCupStartedAt(null);
    setMode(next);
  }

  /** opens the camera and mic so the user can aim, then records a 10–30 second clip */
  async function startRecordFlow() {
    reset("record");
    try {
      const opened = await openCameraAndMic(videoRef.current!);
      streamRef.current = opened.stream;
      closeCameraRef.current = opened.close;
      setAiming(true);
    } catch (e) {
      setMode("idle");
      setFailure({ source: "both", message: `camera or microphone unavailable: ${errorText(e)}` });
    }
  }

  /** the user taps the picture where the drops fall; recording starts */
  function aimAt(e: MouseEvent<HTMLDivElement>) {
    if (!aiming || !streamRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left) / rect.width));
    setColumn(x);
    setAiming(false);
    recorderRef.current = startRecording(streamRef.current);
    const t = performance.now();
    setNow(t);
    setRecordingSince(t);
  }

  /** ends the recording; a 10–30 s clip is analyzed straight away */
  async function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recordingSince === null) return;
    recorderRef.current = null;
    const seconds = (performance.now() - recordingSince) / 1000;
    setRecordingSince(null);
    const blob = await recorder.stop();
    closeCamera();
    streamRef.current = null;
    const issue = lengthProblem(seconds, "recording");
    if (issue) {
      setTooShort(issue);
      return;
    }
    setRecorded({ blob, column, seconds: Math.min(seconds, MAX_SECONDS) });
    setMode("file");
  }

  function finishCup() {
    if (cupStartedAt === null) return;
    const seconds = (performance.now() - cupStartedAt) / 1000;
    const ml = parseFloat(cupMl);
    if (!(ml > 0) || seconds < 0.5) return;
    setResult(streamMeasurement(ml, seconds));
    setCupStartedAt(null);
    setStreamFound(false);
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
  const fallbackFrom: Source | null = mode !== "idle" || streamFound ? null : (failure?.source ?? (lowResult && !useEstimate ? lowResult.source : null));
  const measured = result && result.dropsPerMin !== null && (result.confidence !== "low" || useEstimate) ? result : null;

  // cost math
  const dpm = measured?.dropsPerMin ?? 0;
  const lpd = litersPerDay(dpm);
  const priceNum = Math.max(0, parseFloat(price) || 0);
  const pricePerLiter = unit === "gal" ? priceNum / LITERS_PER_GAL : priceNum;
  const costPerDay = lpd * pricePerLiter;
  const repair = Math.max(0, parseFloat(repairCosts[repairKind]) || 0);
  // the drip is assumed to keep worsening, so the leak catches up with the repair sooner
  const breakEvenDays = breakEvenWithGrowth(costPerDay, repair);
  const shouldFix = breakEvenDays <= FIX_HORIZON_DAYS;
  const howUrgent = urgency({ dropsPerMin: dpm, location, breakEven: breakEvenDays, stream: !!measured?.stream });
  const waits = WAITS.map(([label, days]) => ({ label, days, total: repair + costOfWaiting(costPerDay, days) }));
  const worstWait = Math.max(...waits.map((w) => w.total), 0.01);
  // a year's water with the drip worsening (costOfWaiting with a cost of 1 a day sums the rate growth)
  const litersAYear = lpd * costOfWaiting(1, 365);

  return (
    <div className="min-h-screen bg-sky font-sans text-water-ink">
      <main className="mx-auto max-w-xl px-4 py-6 sm:py-10">
        <header className="flex flex-col items-center gap-1 pb-5">
          <img src={logo} alt="drippy" className="h-20 w-auto sm:h-24" />
          <span className="text-sm font-medium text-water-deep">how much is that drip costing you?</span>
        </header>

        <Section n="1" title="measure" picture={<TapPic className="h-12 w-12" />} tone="water">
          {mode === "idle" && !fallbackFrom && !streamFound && (
            <>
              <p className="text-sm text-water-ink/80">
                record a {MIN_SECONDS}–{MAX_SECONDS} second clip of the drip: prop your phone up facing the tap, close enough
                to hear the drops land, and tap the picture where they fall. drippy then checks every frame and every sound
                and combines them.
              </p>
              <div className="mt-4 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                <div className="min-[400px]:col-span-2">
                  <Choice
                    primary
                    picture={
                      <span className="flex">
                        <CameraPic />
                        <MicPic className="-ml-2 h-10 w-10" />
                      </span>
                    }
                    label={result ? "record again" : `record ${MIN_SECONDS}–${MAX_SECONDS} seconds`}
                    hint="camera + mic: every drop seen and heard"
                    onClick={startRecordFlow}
                  />
                </div>
                <Choice picture={<FingerPic />} label="tap manually" hint="tap along with each drop" onClick={startTapping} />
                <Choice picture={<FilmPic />} label="upload a video" hint={`a ${MIN_SECONDS}–${MAX_SECONDS} s clip of the leak`} onClick={() => reset("file")} />
              </div>
            </>
          )}

          {mode === "file" && (
            <RecordingTester
              key={recorded ? `recorded-${recorded.blob.size}` : "upload"}
              recorded={recorded}
              onUse={(m) => {
                setRecorded(null);
                setResult(m);
                setMode("idle");
              }}
              onStream={(note) => {
                setRecorded(null);
                setMode("idle");
                setStreamNote(note ?? "");
                setStreamFound(true);
              }}
              onRecord={startRecordFlow}
              onCancel={cancel}
            />
          )}

          {mode === "record" && tooShort && (
            <div className="rounded-2xl border-[3px] border-coral bg-coral-light p-4">
              <p className="text-sm font-semibold text-coral-deep">{tooShort}.</p>
              <p className="mt-1 text-sm">
                please record for {MIN_SECONDS}–{MAX_SECONDS} seconds, or upload a {MIN_SECONDS}–{MAX_SECONDS} second video.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button primary onClick={startRecordFlow}>
                  record again
                </Button>
                <Button onClick={() => reset("file")}>upload a video</Button>
                <Button onClick={cancel}>cancel</Button>
              </div>
            </div>
          )}

          {fallbackFrom && (
            <Fallback
              from={fallbackFrom}
              blocked={failure !== null}
              message={failure?.message ?? lowResult?.reason ?? ""}
              estimate={lowResult?.dropsPerMin ?? null}
              onBoth={startRecordFlow}
              onUpload={() => reset("file")}
              onTap={startTapping}
              onUseEstimate={() => setUseEstimate(true)}
            />
          )}

          {streamFound && mode === "idle" && (
            <div className="rounded-2xl border-[3px] border-water-deep bg-sky-soft p-4">
              <div className="flex items-start gap-3">
                <BottlePic className="h-12 w-12 shrink-0" />
                <p className="text-sm">
                  that's a steady stream, not drops{streamNote ? ` (${streamNote})` : ""}, so it can't be counted drop by
                  drop. measure it instead: hold a container under it, press start as the water hits it, and press full when
                  it's full.
                </p>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="text-water-deep">container</span>
                <span className="flex items-baseline">
                  <NumberInput value={cupMl} onChange={setCupMl} step="1" label="container size in ml" />
                  <span className="ml-1">ml</span>
                </span>
                <span className="text-xs text-water-deep">473 ml = 2 cups, a typical water bottle</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {cupStartedAt === null ? (
                  <Button primary onClick={() => setCupStartedAt(performance.now())} disabled={!(parseFloat(cupMl) > 0)}>
                    start
                  </Button>
                ) : (
                  <Button primary onClick={finishCup}>
                    full
                  </Button>
                )}
                <Button onClick={startRecordFlow}>record again</Button>
                <Button onClick={cancel}>cancel</Button>
              </div>
              {cupStartedAt !== null && <CupTimer startedAt={cupStartedAt} />}
            </div>
          )}

          <div
            className={
              mode === "record" && !tooShort
                ? `relative mb-3 overflow-hidden rounded-2xl border-[3px] border-water-deep ${aiming ? "cursor-crosshair" : ""}`
                : "hidden"
            }
            onClick={aimAt}
          >
            <video ref={videoRef} playsInline muted className="block h-auto w-full bg-water-light/40" />
            {aiming ? (
              <div className="absolute inset-x-0 top-0 bg-white/90 p-2 text-center text-sm font-medium text-water-deep">
                tap the picture where the drops fall
              </div>
            ) : (
              <div
                className="absolute inset-y-0 border-x-2 border-water-deep bg-water/20"
                style={{
                  left: `${(column - COLUMN_HALF_WIDTH) * 100}%`,
                  width: `${COLUMN_HALF_WIDTH * 2 * 100}%`,
                }}
              />
            )}
          </div>

          {mode === "record" && aiming && (
            <>
              <p className="text-xs text-water-deep">
                point the camera at the tap so the drops fall through the picture. keep at least a hand's width of the fall
                in view, and rest the phone on something if you can.
              </p>
              <div className="mt-4">
                <Button onClick={cancel}>cancel</Button>
              </div>
            </>
          )}

          {mode === "record" && recordingSince !== null && (
            <>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold text-coral-deep">
                  <span className="h-3 w-3 animate-pulse rounded-full bg-coral" />
                  recording
                </span>
                <span className="rounded-full bg-sky px-3 py-1 text-sm tabular-nums text-water-deep">
                  {clock(elapsed * 1000)} / {clock(MAX_SECONDS * 1000)}
                </span>
              </div>
              <div className="relative mt-2 h-4 overflow-hidden rounded-full border-[3px] border-water-deep bg-white">
                <div
                  className={`absolute inset-y-0 left-0 ${elapsed >= MIN_SECONDS ? "bg-leaf" : "bg-water-light"}`}
                  style={{ width: `${Math.min(1, elapsed / MAX_SECONDS) * 100}%` }}
                />
                <div className="absolute inset-y-0 w-0.5 bg-water-deep" style={{ left: `${(MIN_SECONDS / MAX_SECONDS) * 100}%` }} />
              </div>
              <p className="mt-2 text-xs text-water-deep">
                {elapsed < MIN_SECONDS
                  ? `keep going: at least ${MIN_SECONDS} seconds.`
                  : `you can stop now, or it stops on its own at ${MAX_SECONDS} seconds.`}{" "}
                hold still and keep the room as it is.
              </p>
              <div className="mt-4 flex gap-2">
                <Button primary onClick={() => void stopRecording()}>
                  stop and analyze
                </Button>
                <Button onClick={cancel}>cancel</Button>
              </div>
            </>
          )}

          {mode === "tap" && (
            <>
              <p className="text-sm text-water-ink/80">tap the big button each time a drop lands. 6 or more taps works best.</p>
              <button
                type="button"
                onPointerDown={() => setTaps((t) => [...t, performance.now()])}
                className="mt-4 flex h-36 w-full touch-manipulation select-none flex-col items-center justify-center gap-1 rounded-3xl border-[3px] border-water-deep bg-water-light text-lg font-semibold shadow-chunky active:translate-y-1 active:bg-water active:shadow-none"
              >
                <FingerPic className="h-14 w-14" />
                tap
              </button>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-sm">
                  <span className="text-2xl font-semibold text-water-deep">{taps.length}</span> tap{taps.length === 1 ? "" : "s"}
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
            <DropsDivider />
            <Section n="2" title="rate" picture={<DropPic className="bob h-12 w-12" />} tone="water">
              {measured.stream ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-5xl font-semibold tabular-nums text-water-deep">{Math.round(measured.stream.mlPerMin)}</span>
                    <span className="text-lg">ml / min</span>
                  </div>
                  <p className="mt-2 text-xs text-water-deep">
                    steady stream · a {measured.stream.containerMl} ml container filled in {measured.stream.seconds.toFixed(1)} s ·
                    about {formatRate(dpm)} drops&apos; worth a minute
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-5xl font-semibold tabular-nums text-water-deep">{formatRate(dpm)}</span>
                    <span className="text-lg">drops / min</span>
                  </div>
                  <p className="mt-2 text-xs text-water-deep">
                    one drop every {((measured.intervalMs ?? 0) / 1000).toFixed(1)} s · {measured.confidence} confidence ·{" "}
                    {measured.rough
                      ? `a slow drip: only ${measured.drops} drops fell in ${Math.round(measured.durationMs / 1000)} s, so this is a rough estimate`
                      : measured.byRhythm
                        ? `measured from the steady rhythm of the drops over ${Math.round(measured.durationMs / 1000)} s`
                        : `${measured.drops} drops in a steady rhythm over ${Math.round(measured.durationMs / 1000)} s`}{" "}
                    from {SOURCE_LABEL[measured.source]}
                    {measured.source !== "both" && measured.events > measured.drops
                      ? ` (${measured.events - measured.drops} other ${measured.source === "mic" ? "sounds" : "movements"} ignored)`
                      : ""}
                  </p>
                  {"fused" in measured && <FusedSummary m={measured as Fused} />}
                </>
              )}
              <BottleSimulation
                dropsPerMin={dpm}
                intervalMs={measured.intervalMs ?? 60000 / dpm}
                litersPerDay={lpd}
                stream={!!measured.stream}
              />
            </Section>

            <DropsDivider />
            <Section n="3" title="cost" picture={<CoinsPic className="h-12 w-12" />} tone="coral">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="text-water-deep">water price</span>
                <span className="flex items-baseline">
                  $<NumberInput value={price} onChange={setPrice} step="0.001" label="water price" />
                </span>
                <span className="text-water-deep">per</span>
                <Toggle options={["gal", "l"] as const} value={unit} onChange={switchUnit} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {PERIODS.map(([label, days]) => (
                  <div key={label} className="flex flex-col items-center rounded-2xl border-[3px] border-coral-light bg-coral-light/40 p-3 text-center">
                    {PERIOD_PICTURE[label]}
                    <span className="mt-1 text-xs font-medium text-water-deep">a {label}</span>
                    <span className="text-xl font-semibold tabular-nums text-coral-deep">{formatMoney(costPerDay * days)}</span>
                    <span className="text-xs tabular-nums text-water-deep">{formatVolume(lpd * days, unit)}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-water-deep">assumes 0.25 ml per drop.</p>
            </Section>

            <DropsDivider />
            <Section n="4" title="break-even" picture={<HourglassPic className="h-12 w-12" />} tone="sun">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <span className="text-water-deep">repair</span>
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
                  <p className="mt-4 text-base">
                    the leak costs more than the repair after{" "}
                    <span className="rounded-full bg-sun-light px-2 font-semibold text-sun-deep">{formatDuration(breakEvenDays)}</span>.
                  </p>
                  <p className="mt-1 text-xs text-water-deep">
                    assuming the drip keeps worsening about {Math.round(MONTHLY_GROWTH * 100)}% a month, as worn washers and seals
                    do.
                  </p>
                  <div className="mt-5 flex items-center gap-2">
                    <CoinsPic className="h-9 w-9 shrink-0" />
                    <div className="relative h-5 flex-1 overflow-hidden rounded-full border-[3px] border-water-deep bg-white">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-full ${shouldFix ? "bg-sun" : "bg-water-light"}`}
                        style={{ width: `${Math.min(1, breakEvenDays / FIX_HORIZON_DAYS) * 100}%` }}
                      />
                    </div>
                    <WrenchPic className="h-9 w-9 shrink-0" />
                  </div>
                  <div className="mt-1 flex justify-between px-11 text-xs text-water-deep">
                    <span>today</span>
                    <span>{shouldFix ? "" : "beyond "}1 year</span>
                  </div>
                </>
              ) : (
                <p className="mt-4 text-sm">at this water price the leak costs nothing, so it never outprices the repair.</p>
              )}
            </Section>

            <DropsDivider />
            <Section n="5" title="how urgently" picture={<PiggyPic className="h-12 w-12" />} tone={URGENCY_STYLE[howUrgent.level].tone}>
              <p className="text-sm text-water-deep">where is the leak?</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {LOCATIONS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLocation(l.id)}
                    className={`rounded-full border-[3px] border-water-deep px-3 py-1 text-sm font-medium ${
                      location === l.id ? "bg-water-deep text-white" : "bg-white text-water-deep hover:bg-sky"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>

              <div className={`mt-4 flex items-center gap-4 rounded-2xl border-[3px] p-4 ${URGENCY_STYLE[howUrgent.level].box}`}>
                <div className="flex shrink-0 items-end">
                  {howUrgent.level === "soon" ? <HappyDropPic className="bob h-16 w-16" /> : <SleepyDropPic className="bob h-16 w-16" />}
                  <WrenchPic className="-ml-2 h-10 w-10" />
                </div>
                <div>
                  <p className={`text-3xl font-bold ${URGENCY_STYLE[howUrgent.level].text}`}>{URGENCY_STYLE[howUrgent.level].title}</p>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {howUrgent.reasons.map((r) => (
                      <li key={r}>· {r}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <p className="mt-5 text-sm font-semibold text-water-deep">what it costs in total if you fix it…</p>
              <div className="mt-2 space-y-2">
                {waits.map((w, i) => (
                  <div key={w.label} className="flex items-center gap-3 text-sm">
                    <span className="w-24 shrink-0">{w.label}</span>
                    <div className="relative h-5 flex-1 overflow-hidden rounded-full bg-sky">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-full ${i === 0 ? "bg-leaf" : "bg-coral"}`}
                        style={{ width: `${Math.max(4, (w.total / worstWait) * 100)}%` }}
                      />
                    </div>
                    <span className="w-28 shrink-0 text-right tabular-nums">
                      <span className="font-semibold">{formatMoney(w.total)}</span>
                      {i > 0 && <span className="block text-xs text-coral-deep">+{formatMoney(w.total - waits[0].total)} wasted</span>}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-water-deep">
                the {formatMoney(repair)} {repairKind === "diy" ? "diy repair" : "plumber visit"}, plus the water wasted until then, with
                the drip worsening about {Math.round(MONTHLY_GROWTH * 100)}% a month.
              </p>

              <div className="mt-5 flex items-start gap-3 rounded-2xl bg-sky-soft p-3">
                <BottlePic className="h-10 w-10 shrink-0" />
                <p className="text-sm">
                  left for a year, this leak wastes about <span className="font-semibold">{formatVolume(litersAYear, unit)}</span>:
                  a person's drinking water for{" "}
                  <span className="font-semibold">{formatCount(litersAYear / DRINKING_LITERS_PER_DAY)} days</span>, or{" "}
                  <span className="font-semibold">{formatCount(litersAYear / SHOWER_LITERS)} showers</span>.
                </p>
              </div>
              {measured.confidence === "low" && <p className="mt-2 text-xs text-water-deep">based on a low-confidence estimate.</p>}
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

/** how camera and mic agreed, under the drip rate */
function FusedSummary({ m }: { m: Fused }) {
  const f = m.fused;
  const fmt = (x: Measurement) => (x.dropsPerMin === null || x.confidence === "low" ? "unsure" : `${formatRate(x.dropsPerMin)} / min`);
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
      {f.lagMs !== null && (
        <>
      <div className="rounded-xl bg-leaf-light p-2">
        <span className="block text-lg font-semibold text-leaf-deep">{f.confirmed}</span>
        seen and heard
      </div>
      <div className="rounded-xl bg-sky p-2">
        <span className="block text-lg font-semibold text-water-deep">{f.heardOnly}</span>
        heard only, on the beat
      </div>
      <div className="rounded-xl bg-sky p-2">
        <span className="block text-lg font-semibold text-water-deep">{f.seenOnly}</span>
        seen only, on the beat
      </div>
        </>
      )}
      <p className="col-span-3 text-left text-water-deep">
        sound alone: {f.sound.events || f.sound.dropsPerMin !== null ? fmt(f.sound) : "no sound"} · picture alone: {fmt(f.picture)}
        {f.rates === "agree" ? " · they agree, so drippy uses their average" : ""}
        {f.rates === "disagree" && f.chose ? ` · they found different drips, so drippy went with the clearer one (the ${f.chose})` : ""}
        {f.rates !== "agree" && f.rates !== "disagree" && f.chose ? ` · the ${f.chose} found the drip` : ""}
      </p>
    </div>
  );
}

function CupTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return <p className="mt-3 text-sm tabular-nums">{((now - startedAt) / 1000).toFixed(1)} s</p>;
}

type Tone = "water" | "coral" | "sun" | "leaf";

const URGENCY_STYLE: Record<Urgency, { title: string; tone: Tone; box: string; text: string }> = {
  now: { title: "fix it now", tone: "coral", box: "border-coral bg-coral-light", text: "text-coral-deep" },
  month: { title: "fix it this month", tone: "sun", box: "border-sun bg-sun-light", text: "text-sun-deep" },
  soon: { title: "fix it soon", tone: "leaf", box: "border-leaf bg-leaf-light", text: "text-leaf-deep" },
};

function formatCount(n: number) {
  return n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString("en-US");
}

const TONE_BADGE: Record<Tone, string> = {
  water: "bg-water-light",
  coral: "bg-coral-light",
  sun: "bg-sun-light",
  leaf: "bg-leaf-light",
};

const PERIOD_PICTURE: Record<string, ReactNode> = {
  day: <SunPic className="h-10 w-10" />,
  week: <CalendarPic className="h-10 w-10" mark="7" />,
  month: <CalendarPic className="h-10 w-10" mark="30" />,
  year: <CalendarPic className="h-10 w-10" mark="365" />,
};

function Section({
  n,
  title,
  picture,
  tone,
  children,
}: {
  n: string;
  title: string;
  picture: ReactNode;
  tone: Tone;
  children: ReactNode;
}) {
  return (
    <section className="mb-2 rounded-3xl border-[3px] border-water-deep bg-white p-5 shadow-chunky">
      <h2 className="mb-4 flex items-center gap-3">
        {picture}
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full border-[3px] border-water-deep text-sm font-bold ${TONE_BADGE[tone]}`}
        >
          {n}
        </span>
        <span className="text-xl font-semibold text-water-deep">{title}</span>
      </h2>
      {children}
    </section>
  );
}

/** a big picture button for choosing how to measure */
function Choice({
  picture,
  label,
  hint,
  onClick,
  primary,
}: {
  picture: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-2xl border-[3px] border-water-deep p-3 text-left shadow-chunky transition-transform hover:-translate-y-0.5 active:translate-y-1 active:shadow-none ${
        primary ? "bg-water-light" : "bg-white hover:bg-sky-soft"
      }`}
    >
      <span className="shrink-0">{picture}</span>
      <span>
        <span className="block font-semibold">{label}</span>
        <span className="block text-xs text-water-deep">{hint}</span>
      </span>
    </button>
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
      className={`rounded-full border-[3px] border-water-deep px-5 py-2 text-sm font-medium transition-colors disabled:opacity-30 ${
        primary ? "bg-water-deep text-white hover:bg-water-ink" : "bg-white text-water-deep hover:bg-sky"
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
    <span className="inline-flex overflow-hidden rounded-full border-[3px] border-water-deep">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`px-3 py-0.5 text-sm font-medium ${o === value ? "bg-water-deep text-white" : "bg-white text-water-deep hover:bg-sky"}`}
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
      className="ml-1 w-20 rounded-xl border-2 border-water-light bg-sky-soft px-2 py-0.5 text-sm tabular-nums focus:border-water-deep focus:outline-none"
    />
  );
}

function Fallback({
  from,
  blocked,
  message,
  estimate,
  onBoth,
  onTap,
  onUpload,
  onUseEstimate,
}: {
  from: Source;
  /** a device couldn't be opened at all, rather than giving an unclear reading */
  blocked: boolean;
  message: string;
  estimate: number | null;
  onBoth: () => void;
  onTap: () => void;
  onUpload: () => void;
  onUseEstimate: () => void;
}) {
  const text = blocked
    ? `${message}. allow the camera and microphone in your browser and try again, upload a 10–30 second video, or tap along with the drops.`
    : from === "tap"
      ? `couldn't get a steady rhythm from your taps (${message}).`
      : `couldn't confirm the drops with camera and mic together (${message}). make sure you tapped where the drops fall, add light, and move the phone closer, or tap along with the drops.`;

  return (
    <div className="rounded-2xl border-[3px] border-sun bg-sun-light p-4">
      <div className="flex items-start gap-3">
        <SleepyDropPic className="h-12 w-12 shrink-0" />
        <p className="text-sm">{text}</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {from === "tap" ? (
          <>
            <Button primary onClick={onTap}>
              tap again
            </Button>
            <Button onClick={onBoth}>try camera + mic</Button>
          </>
        ) : (
          <>
            <Button primary onClick={onBoth}>
              try again
            </Button>
            <Button onClick={onUpload}>upload a video</Button>
            <Button onClick={onTap}>tap manually</Button>
          </>
        )}
      </div>
      {estimate !== null && (
        <button type="button" onClick={onUseEstimate} className="mt-3 text-xs text-water-deep underline hover:text-water-ink">
          use the rough estimate anyway ({formatRate(estimate)} drops / min)
        </button>
      )}
    </div>
  );
}
