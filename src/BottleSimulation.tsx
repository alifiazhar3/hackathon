import { useEffect, useId, useState, type CSSProperties } from "react";
import { DROP_ML, formatDuration, PERIODS } from "@/lib/drips";

const BOTTLE_ML = 473;
const DROPS_PER_BOTTLE = BOTTLE_ML / DROP_ML;
/** most bottle icons shown before each icon stands for 10, 100, ... bottles */
const MAX_ICONS = 50;

const FALL_MS = 700;
const RIPPLE_MS = 900;
/** below this gap between drops, show a stream instead of separate drops */
const STREAM_BELOW_MS = 200;

const PERIOD_OPTIONS = PERIODS.filter(([label]) => label !== "week");

// bottle drawn in a 40 × 100 box: cap on top, sloped shoulders, ribbed body
const BOTTLE_BODY =
  "M15,10 L6,26 V40 Q10,43 6,46 V56 Q10,59 6,62 V72 Q10,75 6,78 V91 Q6,96 11,96 H29 Q34,96 34,91 V78 Q30,75 34,72 V62 Q30,59 34,56 V46 Q30,43 34,40 V26 L25,10 Z";
const WATER_BOTTOM = 96;
const WATER_TOP = 24;

function waterY(fill: number) {
  return WATER_BOTTOM - Math.min(1, Math.max(0, fill)) * (WATER_BOTTOM - WATER_TOP);
}

function Bottle({ fill, cap = true, className }: { fill: number; cap?: boolean; className?: string }) {
  const clipId = useId();
  const y = waterY(fill);
  return (
    // explicit size so it also works nested inside another svg
    <svg viewBox="0 0 40 100" width={40} height={100} className={className} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <path d={BOTTLE_BODY} />
        </clipPath>
      </defs>
      {fill > 0 && (
        <g clipPath={`url(#${clipId})`}>
          <path
            d={`M0,${y} Q10,${y - 2.5} 20,${y} T40,${y} V100 H0 Z`}
            fill="#2563eb"
            fillOpacity={0.25}
            stroke="#2563eb"
            strokeWidth={1.2}
            style={{ transition: "d 0.4s ease" }}
          />
        </g>
      )}
      <path d={BOTTLE_BODY} fill="none" stroke="#171717" strokeWidth={2.4} strokeLinejoin="round" />
      {cap && <rect x={13} y={1.5} width={14} height={8.5} rx={2} fill="none" stroke="#171717" strokeWidth={2.4} />}
    </svg>
  );
}

function formatBottles(n: number) {
  if (n < 10) return Number(n.toFixed(1)).toString();
  return Math.round(n).toLocaleString("en-US");
}

/** a tap dripping into a bottle in real time, at the measured rate */
function LiveBottle({ dropsPerMin, intervalMs }: { dropsPerMin: number; intervalMs: number }) {
  const [drops, setDrops] = useState<number[]>([]);
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
      setDrops((d) => [...d, n]);
      timeouts.push(window.setTimeout(() => setLanded((x) => x + 1), FALL_MS));
      timeouts.push(window.setTimeout(() => setDrops((d) => d.filter((x) => x !== n)), FALL_MS + RIPPLE_MS));
    };
    spawn();
    const timer = window.setInterval(spawn, intervalMs);
    return () => {
      window.clearInterval(timer);
      timeouts.forEach((t) => window.clearTimeout(t));
      setDrops([]);
    };
  }, [intervalMs, dropsPerMin, stream]);

  const inBottle = landed % DROPS_PER_BOTTLE;
  const fill = inBottle / DROPS_PER_BOTTLE;
  const bottlesDone = Math.floor(landed / DROPS_PER_BOTTLE);

  // svg layout: tap at the top, open bottle (scaled 1.4×) below it
  const SCALE = 1.4;
  const BOTTLE_X = 60 - 20 * SCALE;
  const BOTTLE_Y = 56;
  const DROP_START_Y = 20;
  const surfaceY = BOTTLE_Y + waterY(fill) * SCALE;
  const minutesPerBottle = DROPS_PER_BOTTLE / dropsPerMin;

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 120 196" className="h-56 w-[137px] shrink-0" role="img" aria-label="a tap dripping into a bottle in real time">
        <rect x={46} y={0} width={28} height={8} fill="#171717" />
        <rect x={56} y={8} width={8} height={10} fill="#171717" />

        {stream ? (
          <line
            className="drip-stream"
            x1={60}
            x2={60}
            y1={DROP_START_Y - 2}
            y2={surfaceY}
            stroke="#2563eb"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        ) : (
          drops.map((n) => (
            <g key={n}>
              <g transform={`translate(60 ${DROP_START_Y})`}>
                <path
                  className="drip-fall"
                  d="M0,-4 C1.5,-1.5 2.6,0 2.6,1.4 A2.6,2.6 0 0 1 -2.6,1.4 C-2.6,0 -1.5,-1.5 0,-4 Z"
                  fill="#2563eb"
                  style={{ "--fall": `${surfaceY - DROP_START_Y}px`, animationDuration: `${FALL_MS}ms` } as CSSProperties}
                />
              </g>
              <ellipse
                className="drip-ripple"
                cx={60}
                cy={surfaceY}
                rx={10}
                ry={2}
                fill="none"
                stroke="#2563eb"
                style={{ animationDelay: `${FALL_MS}ms`, animationDuration: `${RIPPLE_MS}ms` }}
              />
            </g>
          ))
        )}

        <g transform={`translate(${BOTTLE_X} ${BOTTLE_Y}) scale(${SCALE})`}>
          <Bottle fill={fill} cap={false} />
        </g>
      </svg>

      <div className="text-sm">
        <p className="tabular-nums">
          {Math.floor(inBottle).toLocaleString("en-US")} / {Math.round(DROPS_PER_BOTTLE).toLocaleString("en-US")} drops
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          {bottlesDone > 0 ? `${bottlesDone} bottle${bottlesDone === 1 ? "" : "s"} filled so far. ` : ""}
          fills one bottle every {minutesPerBottle < 60 ? `${Math.max(1, Math.round(minutesPerBottle))} min` : formatDuration(minutesPerBottle / 1440)}.
        </p>
        <p className="mt-3 text-xs text-neutral-500">
          {stream
            ? `real time: about ${Math.round(dropsPerMin / 60)} drops a second, too fast to see one by one`
            : `real time: one drop every ${(intervalMs / 1000).toFixed(1)} s`}
        </p>
      </div>
    </div>
  );
}

export function BottleSimulation({
  dropsPerMin,
  intervalMs,
  litersPerDay,
}: {
  dropsPerMin: number;
  intervalMs: number;
  litersPerDay: number;
}) {
  const [period, setPeriod] = useState("year");

  const days = PERIOD_OPTIONS.find(([label]) => label === period)?.[1] ?? 1;
  const bottles = (litersPerDay * 1000 * days) / BOTTLE_ML;
  const perIcon = bottles > MAX_ICONS ? 10 ** Math.ceil(Math.log10(bottles / MAX_ICONS)) : 1;
  const icons = bottles / perIcon;
  const full = Math.floor(icons);
  const partial = icons - full;
  const fills = [...Array(full).fill(1), ...(partial > 0.01 || full === 0 ? [partial] : [])];

  return (
    <div className="mt-6 space-y-6">
      <LiveBottle dropsPerMin={dropsPerMin} intervalMs={intervalMs} />

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-sm">
            <span className="text-blue-600">{formatBottles(bottles)}</span> bottle{bottles === 1 ? "" : "s"} a {period}
          </p>
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
        <div className="flex flex-wrap gap-1" role="img" aria-label={`${formatBottles(bottles)} bottles a ${period}`}>
          {fills.map((f, i) => (
            <Bottle key={i} fill={f} className="h-12 w-5" />
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          {perIcon > 1 ? `each bottle = ${perIcon.toLocaleString("en-US")} bottles · ` : ""}
          {BOTTLE_ML} ml (about 2 cups) per bottle
        </p>
      </div>
    </div>
  );
}
