import { useEffect, useState, type CSSProperties } from "react";
import { formatDuration, formatVolume, PERIODS, type Unit } from "@/lib/drips";

/** 50 m × 25 m × 2 m */
const POOL_LITERS = 2_500_000;
const POOL_DEPTH_M = 2;

const FALL_MS = 700;
const RIPPLE_MS = 900;
/** below this gap between drops, show a stream instead of separate drops */
const STREAM_BELOW_MS = 200;

// svg layout (user units)
const W = 320;
const TAP_X = 160;
const DROP_START_Y = 20;
const POOL_LEFT = 20;
const POOL_RIGHT = 300;
const POOL_TOP = 80;
const POOL_BOTTOM = 170;
const POOL_HEIGHT = POOL_BOTTOM - POOL_TOP;
const INSET_HEIGHT = 50;

const PERIOD_OPTIONS = PERIODS.filter(([label]) => label !== "week");

function formatPercent(fraction: number) {
  const pct = fraction * 100;
  if (pct < 0.000001) return "<0.000001%";
  if (pct < 1) return `${Number(pct.toPrecision(2))}%`;
  return `${pct.toFixed(1)}%`;
}

function formatDepth(m: number) {
  if (m >= 1) return `${Number(m.toPrecision(2))} m`;
  if (m >= 0.01) return `${Number((m * 100).toPrecision(2))} cm`;
  return `${Number((m * 1000).toPrecision(2))} mm`;
}

/** the power-of-ten zoom that makes the water fill 10–100% of the inset */
function zoomFor(fraction: number) {
  if (fraction <= 0 || fraction >= 0.1) return 1;
  return 10 ** Math.ceil(Math.log10(0.1 / fraction));
}

export function PoolSimulation({
  dropsPerMin,
  intervalMs,
  litersPerDay,
  unit,
}: {
  dropsPerMin: number;
  intervalMs: number;
  litersPerDay: number;
  unit: Unit;
}) {
  const [period, setPeriod] = useState("day");
  const [drops, setDrops] = useState<number[]>([]);
  const stream = intervalMs < STREAM_BELOW_MS;

  const days = PERIOD_OPTIONS.find(([label]) => label === period)?.[1] ?? 1;
  const liters = litersPerDay * days;
  const fraction = liters / POOL_LITERS;
  const fillHeight = Math.min(1, fraction) * POOL_HEIGHT;
  const surfaceY = POOL_BOTTOM - fillHeight;
  const zoom = zoomFor(fraction);
  const daysToFill = litersPerDay > 0 ? POOL_LITERS / litersPerDay : Infinity;

  // spawn drops in real time at the measured rate
  useEffect(() => {
    if (stream) return;
    let id = 0;
    const spawn = () => {
      const n = ++id;
      setDrops((d) => [...d, n]);
      window.setTimeout(() => setDrops((d) => d.filter((x) => x !== n)), FALL_MS + RIPPLE_MS);
    };
    spawn();
    const timer = window.setInterval(spawn, intervalMs);
    return () => {
      window.clearInterval(timer);
      setDrops([]);
    };
  }, [intervalMs, stream]);

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-neutral-500">olympic pool after one</span>
        <span className="inline-flex border border-neutral-300">
          {PERIOD_OPTIONS.map(([label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setPeriod(label)}
              className={`px-2 py-0.5 text-sm ${label === period ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"}`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${POOL_BOTTOM + 2}`} className="block w-full" role="img" aria-label="drops falling into an olympic pool">
        {/* tap */}
        <rect x={TAP_X - 14} y={0} width={28} height={8} fill="#171717" />
        <rect x={TAP_X - 4} y={8} width={8} height={10} fill="#171717" />

        {/* water: true scale */}
        <rect
          x={POOL_LEFT + 1}
          y={surfaceY}
          width={POOL_RIGHT - POOL_LEFT - 2}
          height={fillHeight}
          fill="#2563eb"
          fillOpacity={0.2}
          style={{ transition: "y 0.6s ease, height 0.6s ease" }}
        />
        <line
          x1={POOL_LEFT + 1}
          x2={POOL_RIGHT - 1}
          y1={surfaceY}
          y2={surfaceY}
          stroke="#2563eb"
          strokeWidth={fillHeight > 0 ? 1 : 0}
          style={{ transition: "all 0.6s ease" }}
        />

        {/* drops or stream */}
        {stream ? (
          <line
            className="drip-stream"
            x1={TAP_X}
            x2={TAP_X}
            y1={DROP_START_Y - 2}
            y2={surfaceY}
            stroke="#2563eb"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        ) : (
          drops.map((n) => (
            <g key={n}>
              <g transform={`translate(${TAP_X} ${DROP_START_Y})`}>
                <path
                  className="drip-fall"
                  d="M0,-4 C1.5,-1.5 2.6,0 2.6,1.4 A2.6,2.6 0 0 1 -2.6,1.4 C-2.6,0 -1.5,-1.5 0,-4 Z"
                  fill="#2563eb"
                  style={{ "--fall": `${surfaceY - DROP_START_Y}px`, animationDuration: `${FALL_MS}ms` } as CSSProperties}
                />
              </g>
              <ellipse
                className="drip-ripple"
                cx={TAP_X}
                cy={surfaceY}
                rx={16}
                ry={3}
                fill="none"
                stroke="#2563eb"
                style={{ animationDelay: `${FALL_MS}ms`, animationDuration: `${RIPPLE_MS}ms` }}
              />
            </g>
          ))
        )}

        {/* pool walls and deck */}
        <path
          d={`M0 ${POOL_TOP} H${POOL_LEFT} V${POOL_BOTTOM} H${POOL_RIGHT} V${POOL_TOP} H${W}`}
          fill="none"
          stroke="#171717"
          strokeWidth={1.5}
        />
      </svg>

      <p className="mt-1 text-xs text-neutral-500">
        {stream
          ? `real time: about ${Math.round(dropsPerMin / 60)} drops a second, too fast to see one by one`
          : `real time: one drop every ${(intervalMs / 1000).toFixed(1)} s`}
        {" · pool 50 m long, depth not to scale"}
      </p>

      {zoom > 1 && (
        <div className="mt-4">
          <svg viewBox={`0 0 ${W} 58`} className="block w-full" role="img" aria-label={`bottom of the pool magnified ${zoom} times`}>
            <rect
              x={POOL_LEFT + 1}
              y={4 + INSET_HEIGHT - fraction * zoom * INSET_HEIGHT}
              width={POOL_RIGHT - POOL_LEFT - 2}
              height={fraction * zoom * INSET_HEIGHT}
              fill="#2563eb"
              fillOpacity={0.2}
              stroke="#2563eb"
              strokeWidth={1}
              style={{ transition: "y 0.6s ease, height 0.6s ease" }}
            />
            <path
              d={`M${POOL_LEFT} 4 V${4 + INSET_HEIGHT} H${POOL_RIGHT} V4`}
              fill="none"
              stroke="#171717"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          </svg>
          <p className="mt-1 text-xs text-neutral-500">
            × {zoom.toLocaleString("en-US")} zoom: the bottom {formatDepth(POOL_DEPTH_M / zoom)} of the pool
          </p>
        </div>
      )}

      <p className="mt-4 text-sm">
        {formatVolume(liters, unit)} · <span className="text-blue-600">{formatPercent(fraction)}</span> of an olympic pool
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        {Number.isFinite(daysToFill) ? `at this rate it would take ${formatDuration(daysToFill)} to fill it.` : ""}
      </p>
    </div>
  );
}
