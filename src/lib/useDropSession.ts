import { useCallback, useEffect, useRef, useState } from "react";
import { OnsetDetector, Trace, type DetectorOptions } from "@/lib/detect";
import type { Sampler } from "@/lib/samplers";
import type { Source } from "@/lib/drips";

type Options = {
  /** keep going at least this long */
  minMs: number;
  /** give up after this long, however many drops were found */
  maxMs: number;
  /** drops needed before stopping at minMs */
  minDrops: number;
  onDone: (source: Source, onsets: number[], durationMs: number) => void;
};

/** runs a sampler frame by frame, counts drops and draws the live trace */
export function useDropSession(options: Options) {
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [drops, setDrops] = useState(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplerRef = useRef<Sampler | null>(null);
  const sourceRef = useRef<Source>("mic");
  const rafRef = useRef<number | null>(null);
  const onsetsRef = useRef<number[]>([]);
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
    cancel();
    optionsRef.current.onDone(sourceRef.current, [...onsetsRef.current], duration);
  }, [cancel]);

  const start = useCallback(
    (sampler: Sampler, source: Source, detectorOptions: DetectorOptions) => {
      cancel();
      const detector = new OnsetDetector(detectorOptions);
      const trace = new Trace();
      samplerRef.current = sampler;
      sourceRef.current = source;
      onsetsRef.current = [];
      t0Ref.current = performance.now();
      setElapsed(0);
      setDrops(0);
      setRunning(true);

      let lastUiUpdate = 0;
      const tick = () => {
        const t = performance.now() - t0Ref.current;
        const value = sampler.sample();
        const hit = detector.push(value, t);
        if (hit) onsetsRef.current.push(t);
        trace.push(value, detector.threshold(), hit);
        trace.draw(canvasRef.current);

        if (hit || t - lastUiUpdate > 100) {
          lastUiUpdate = t;
          setElapsed(t);
          setDrops(onsetsRef.current.length);
        }

        const { minMs, maxMs, minDrops } = optionsRef.current;
        if ((t >= minMs && onsetsRef.current.length >= minDrops) || t >= maxMs) {
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

  return { running, elapsed, drops, canvasRef, start, finish, cancel };
}
