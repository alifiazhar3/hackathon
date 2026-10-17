import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

type Severity = "low" | "medium" | "high";

type ScanRecord = {
  id: string;
  created_at: string;
  severity: Severity;
  dominant_freq: number;
  high_energy: number;
  total_energy: number;
  score: number;
};

const severityInfo: Record<Severity, { color: string; bg: string; desc: string }> = {
  low: { color: "text-emerald-600", bg: "bg-emerald-50", desc: "minimal hiss. likely no active leak." },
  medium: { color: "text-amber-600", bg: "bg-amber-50", desc: "steady hiss. a seal may be failing." },
  high: { color: "text-red-600", bg: "bg-red-50", desc: "strong pressurized hiss. call a plumber." },
};

function scoreToSeverity(score: number): Severity {
  if (score >= 0.55) return "high";
  if (score >= 0.28) return "medium";
  return "low";
}

const BAR_COUNT = 48;

function App() {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [readout, setReadout] = useState<{ freq: number; high: number; total: number; score: number; sev: Severity } | null>(null);
  const [saved, setSaved] = useState<ScanRecord[]>([]);
  const [saving, setSaving] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const dataRef = useRef<Uint8Array | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (ctxRef.current && ctxRef.current.state !== "closed") {
      ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
    analyserRef.current = null;
    dataRef.current = null;
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setReadout(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      dataRef.current = data;
      setListening(true);

      const tick = () => {
        if (!analyserRef.current || !dataRef.current) return;
        analyserRef.current.getByteFrequencyData(dataRef.current);

        const nyquist = ctx.sampleRate / 2;
        const binCount = dataRef.current.length;
        const binHz = nyquist / binCount;

        const usable = Math.floor(binCount * 0.5);
        const step = Math.floor(usable / BAR_COUNT) || 1;
        const next: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += dataRef.current[i * step + j] ?? 0;
          next.push(sum / step / 255);
        }
        setBars(next);

        let highSum = 0, highCount = 0, totalSum = 0, peakIdx = 0, peakVal = 0;
        for (let i = 0; i < binCount; i++) {
          const v = dataRef.current[i];
          totalSum += v;
          const freq = i * binHz;
          if (freq >= 5000 && freq <= 16000) { highSum += v; highCount++; }
          if (v > peakVal) { peakVal = v; peakIdx = i; }
        }
        const high = highCount > 0 ? highSum / highCount / 255 : 0;
        const total = binCount > 0 ? totalSum / binCount / 255 : 0;
        const score = Math.min(1, high * 1.6 + total * 0.15);

        setReadout({ freq: peakIdx * binHz, high, total, score, sev: scoreToSeverity(score) });
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(e instanceof Error ? e.message.toLowerCase() : "could not access microphone");
      setListening(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (ctxRef.current && ctxRef.current.state !== "closed") ctxRef.current.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("drippy_scans").select("*").order("created_at", { ascending: false }).limit(20);
      if (data) setSaved(data as ScanRecord[]);
    })();
  }, []);

  async function saveScan() {
    if (!readout) return;
    setSaving(true);
    const { data } = await supabase
      .from("drippy_scans")
      .insert({
        severity: readout.sev,
        dominant_freq: Math.round(readout.freq),
        high_energy: Number(readout.high.toFixed(3)),
        total_energy: Number(readout.total.toFixed(3)),
        score: Number(readout.score.toFixed(3)),
      })
      .select("*")
      .single();
    if (data) setSaved((prev) => [data as ScanRecord, ...prev].slice(0, 20));
    setSaving(false);
  }

  async function deleteScan(id: string) {
    const { error } = await supabase.from("drippy_scans").delete().eq("id", id);
    if (!error) setSaved((prev) => prev.filter((s) => s.id !== id));
  }

  const sev = readout ? severityInfo[readout.sev] : null;

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto max-w-md px-5 py-10">
        {/* header */}
        <div className="mb-8 flex items-center gap-2">
          <Mic size={18} className="text-cyan-600" />
          <h1 className="text-lg font-semibold lowercase">drippy</h1>
        </div>

        {/* control */}
        <div className="mb-6">
          {!listening ? (
            <button
              onClick={start}
              className="w-full rounded-lg bg-cyan-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-cyan-700 lowercase"
            >
              start listening
            </button>
          ) : (
            <button
              onClick={stop}
              className="w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 lowercase"
            >
              stop
            </button>
          )}
        </div>

        {error && (
          <p className="mb-6 rounded-lg bg-red-50 p-3 text-xs text-red-700 lowercase">{error}. allow mic access and try again.</p>
        )}

        {/* waveform */}
        <div className="mb-6 flex h-32 items-end justify-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          {bars.map((h, i) => (
            <span
              key={i}
              className={`w-1.5 rounded-sm ${listening ? "bg-cyan-600" : "bg-neutral-300"}`}
              style={{ height: `${Math.max(2, h * 100)}%`, transition: "height 0.08s linear" }}
            />
          ))}
        </div>

        {/* live readout */}
        {listening && readout && sev && (
          <div className="mb-8 space-y-4">
            <div className={`rounded-lg p-4 ${sev.bg}`}>
              <p className="text-xs text-neutral-500 lowercase">severity</p>
              <p className={`mt-1 text-3xl font-bold lowercase ${sev.color}`}>{readout.sev}</p>
              <p className="mt-2 text-xs text-neutral-600 lowercase">{sev.desc}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-200">
                <div className={`h-full rounded-full ${readout.sev === "high" ? "bg-red-500" : readout.sev === "medium" ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.round(readout.score * 100)}%` }} />
              </div>
            </div>

            <div className="rounded-lg border border-neutral-200 p-4 text-sm">
              <Row label="dominant freq" value={`${(readout.freq / 1000).toFixed(1)} khz`} />
              <Row label="high-band energy" value={`${Math.round(readout.high * 100)}%`} />
              <Row label="overall energy" value={`${Math.round(readout.total * 100)}%`} />
              <Row label="leak score" value={`${Math.round(readout.score * 100)}`} />
            </div>

            <button
              onClick={saveScan}
              disabled={saving}
              className="w-full rounded-lg border border-cyan-600 px-4 py-2.5 text-sm font-semibold text-cyan-700 transition-colors hover:bg-cyan-50 disabled:opacity-40 lowercase"
            >
              {saving ? "saving..." : "save scan"}
            </button>
          </div>
        )}

        {!listening && !error && (
          <p className="mb-8 text-center text-xs text-neutral-400 lowercase">press start, then hold your phone near a wall or pipe.</p>
        )}

        {/* history */}
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">saved scans</p>
          {saved.length === 0 ? (
            <p className="text-xs text-neutral-400 lowercase">no saved scans yet.</p>
          ) : (
            <div className="space-y-2">
              {saved.map((s) => {
                const info = severityInfo[s.severity];
                return (
                  <div key={s.id} className="flex items-center justify-between rounded-lg border border-neutral-200 p-3">
                    <div>
                      <p className={`text-sm font-semibold lowercase ${info.color}`}>{s.severity}</p>
                      <p className="mt-0.5 text-xs text-neutral-500 lowercase">
                        {(s.dominant_freq / 1000).toFixed(1)} khz · score {Math.round(s.score * 100)} · {new Date(s.created_at).toLocaleString().toLowerCase()}
                      </p>
                    </div>
                    <button
                      onClick={() => deleteScan(s.id)}
                      className="rounded p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      aria-label="delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-neutral-500 lowercase">{label}</span>
      <span className="font-medium lowercase">{value}</span>
    </div>
  );
}

export default App;
