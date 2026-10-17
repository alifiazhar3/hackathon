import { useCallback, useEffect, useRef, useState } from "react";

type AnalysisState = {
  bars: Uint8Array;
  dominantFreq: number;
  highEnergy: number;
  totalEnergy: number;
};

export function useAudioScanner() {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null);
  const [bars, setBars] = useState<number[]>(() => Array(48).fill(0));

  const audioCtxRef = useRef<AudioContext | null>(null);
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
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    dataRef.current = null;
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setAnalysis(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

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

        // downsample to display bars
        const displayCount = 48;
        const usable = Math.floor(binCount * 0.5); // show up to ~11khz for visuals
        const step = Math.floor(usable / displayCount) || 1;
        const next: number[] = [];
        for (let i = 0; i < displayCount; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) {
            sum += dataRef.current[i * step + j] ?? 0;
          }
          next.push(sum / step / 255);
        }
        setBars(next);

        // high-frequency energy (5khz - 16khz) — where water hiss lives
        let highSum = 0;
        let highCount = 0;
        let totalSum = 0;
        let peakIdx = 0;
        let peakVal = 0;
        for (let i = 0; i < binCount; i++) {
          const v = dataRef.current[i];
          totalSum += v;
          const freq = i * binHz;
          if (freq >= 5000 && freq <= 16000) {
            highSum += v;
            highCount++;
          }
          if (v > peakVal) {
            peakVal = v;
            peakIdx = i;
          }
        }
        const highEnergy = highCount > 0 ? highSum / highCount / 255 : 0;
        const totalEnergy = binCount > 0 ? totalSum / binCount / 255 : 0;
        const dominantFreq = peakIdx * binHz;

        setAnalysis({ bars: dataRef.current, dominantFreq, highEnergy, totalEnergy });

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "could not access microphone";
      setError(msg.toLowerCase());
      setListening(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  return { listening, error, bars, analysis, start, stop };
}
