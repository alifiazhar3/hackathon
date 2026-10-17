import { useCallback, useEffect, useRef, useState } from "react";
import { Trace } from "@/lib/detect";
import type { Sampler, SamplerStatus } from "@/lib/samplers";
import type { Source } from "@/lib/drips";

/** a steady stream must be seen this long before measuring stops */
const STREAM_CONFIRM_MS = 3000;

type Options = {
  /** keep going at least this long */
  minMs: number;
  /** give up after this long, however many drops were found */
  maxMs: number;
  /** detections needed before stopping at minMs */
  minDrops: number;
  onDone: (source: Source, onsets: number[], durationMs: number, stream: boolean) => void;
};

/** runs a sampler, collects drop times and draws the live trace */
export function useDropSession(options: Options) {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [onsets, setOnsets] = useState<number[]>([]);
  const [status, setStatus] = useState<SamplerStatus>("calibrating");

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplerRef = useRef<Sampler | null>(null);
  const sourceRef = useRef<Source>("mic");
  const rafRef = useRef<number | null>(null);
  const onsetsRef = useRef<number[]>([]);
  const streamSinceRef = useRef<number | null>(null);
  const t0Ref = useRef(0);

  const cancel = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    samplerRef.current?.stop();
    samplerRef.current = null;
    setRunning(false);
  }, []);

  const finish = useCallback(() => {
    if (!samplerRef.current) return;
    const duration = performance.now() - t0Ref.current;
    const stream = samplerRef.current.status() === "stream";
    cancel();
    optionsRef.current.onDone(sourceRef.current, [...onsetsRef.current], duration, stream);
  }, [cancel]);

  const start = useCallback(
    (sampler: Sampler, source: Source) => {
      cancel();
      const trace = new Trace();
      samplerRef.current = sampler;
      sourceRef.current = source;
      onsetsRef.current = [];
      streamSinceRef.current = null;
      t0Ref.current = performance.now();
      setElapsed(0);
      setOnsets([]);
      setStatus(sampler.status());
      setRunning(true);

      let lastUiUpdate = 0;
      const tick = () => {
        const t = performance.now() - t0Ref.current;
        const fresh = sampler.takeOnsets();
        onsetsRef.current.push(...fresh);
        trace.push(sampler.level(), sampler.threshold(), fresh.length > 0);
        trace.draw(canvasRef.current);

        const st = sampler.status();
        if (st === "stream") streamSinceRef.current ??= t;
        else streamSinceRef.current = null;

        if (fresh.length || t - lastUiUpdate > 100) {
          lastUiUpdate = t;
          setElapsed(t);
          setStatus(st);
          if (fresh.length) setOnsets([...onsetsRef.current]);
        }

        const { minMs, maxMs, minDrops } = optionsRef.current;
        const streamConfirmed = streamSinceRef.current !== null && t - streamSinceRef.current >= STREAM_CONFIRM_MS;
        if (streamConfirmed || (t >= minMs && onsetsRef.current.length >= minDrops) || t >= maxMs) {
          finish();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [cancel, finish],
  );

  useEffect(() => cancel, [cancel]);

  return { running, elapsed, onsets, status, canvasRef, start, finish, cancel };
}
