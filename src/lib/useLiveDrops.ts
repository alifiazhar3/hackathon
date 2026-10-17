import { useEffect, useState } from "react";

export const FALL_MS = 700;
export const RIPPLE_MS = 900;
/** below this gap between drops, show a stream instead of separate drops */
export const STREAM_BELOW_MS = 200;

export type LiveDrop = { id: number; spawnedAt: number };

/** drops spawned in real time at the measured rate, and how many have landed */
export function useLiveDrops(dropsPerMin: number, intervalMs: number) {
  const [drops, setDrops] = useState<LiveDrop[]>([]);
  const [landed, setLanded] = useState(0);
  const stream = intervalMs < STREAM_BELOW_MS;

  useEffect(() => {
    setLanded(0);
    if (stream) {
      // too fast for single drops: add water continuously
      const timer = window.setInterval(() => setLanded((n) => n + dropsPerMin / 600), 100);
      return () => window.clearInterval(timer);
    }
    let id = 0;
    const timeouts: number[] = [];
    const spawn = () => {
      const n = ++id;
      setDrops((d) => [...d, { id: n, spawnedAt: performance.now() }]);
      timeouts.push(window.setTimeout(() => setLanded((x) => x + 1), FALL_MS));
      timeouts.push(window.setTimeout(() => setDrops((d) => d.filter((x) => x.id !== n)), FALL_MS + RIPPLE_MS));
    };
    spawn();
    const timer = window.setInterval(spawn, intervalMs);
    return () => {
      window.clearInterval(timer);
      timeouts.forEach((t) => window.clearTimeout(t));
      setDrops([]);
    };
  }, [intervalMs, dropsPerMin, stream]);

  return { drops, landed, stream };
}
