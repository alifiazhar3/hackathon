import { Component, lazy, Suspense, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { bottleGroups, groupLabel, type BottleGroup } from "@/lib/bottles";
import { DROP_ML, formatDuration, PERIODS } from "@/lib/drips";
import { FALL_MS, RIPPLE_MS, useLiveDrops, type LiveDrop } from "@/lib/useLiveDrops";

const BottleScene = lazy(() => import("@/BottleScene"));

export const BOTTLE_ML = 473;
export const DROPS_PER_BOTTLE = BOTTLE_ML / DROP_ML;

const PERIOD_OPTIONS = PERIODS.filter(([label]) => label !== "week");

// bottle drawn in a 40 × 100 box: cap on top, sloped shoulders, ribbed body
const BOTTLE_BODY =
  "M15,10 L6,26 V40 Q10,43 6,46 V56 Q10,59 6,62 V72 Q10,75 6,78 V91 Q6,96 11,96 H29 Q34,96 34,91 V78 Q30,75 34,72 V62 Q30,59 34,56 V46 Q30,43 34,40 V26 L25,10 Z";
const WATER_BOTTOM = 96;
const WATER_TOP = 24;

function waterY(fill: number) {
  return WATER_BOTTOM - Math.min(1, Math.max(0, fill)) * (WATER_BOTTOM - WATER_TOP);
}

function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** shows the flat version if the 3d scene throws */
class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Bottle({
  fill,
  cap = true,
  className,
  style,
}: {
  fill: number;
  cap?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const clipId = useId();
  const y = waterY(fill);
  return (
    // explicit size so it also works nested inside another svg
    <svg viewBox="0 0 40 100" width={40} height={100} className={className} style={style} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <path d={BOTTLE_BODY} />
        </clipPath>
      </defs>
      {fill > 0 && (
        <g clipPath={`url(#${clipId})`}>
          <path
            d={`M0,${y} Q10,${y - 2.5} 20,${y} T40,${y} V100 H0 Z`}
            fill="#5b9fd0"
            fillOpacity={0.25}
            stroke="#5b9fd0"
            strokeWidth={1.2}
            style={{ transition: "d 0.4s ease" }}
          />
        </g>
      )}
      <path d={BOTTLE_BODY} fill="none" stroke="#4d73ad" strokeWidth={2.4} strokeLinejoin="round" />
      {cap && <rect x={13} y={1.5} width={14} height={8.5} rx={2} fill="none" stroke="#4d73ad" strokeWidth={2.4} />}
    </svg>
  );
}

function formatBottles(n: number) {
  if (n < 10) return Number(n.toFixed(1)).toString();
  return Math.round(n).toLocaleString("en-US");
}

/** flat fallback: a tap dripping into one bottle */
function FlatLiveBottle({ drops, stream, fill }: { drops: LiveDrop[]; stream: boolean; fill: number }) {
  // svg layout: tap at the top, open bottle (scaled 1.4×) below it
  const SCALE = 1.4;
  const BOTTLE_X = 60 - 20 * SCALE;
  const BOTTLE_Y = 56;
  const DROP_START_Y = 20;
  const surfaceY = BOTTLE_Y + waterY(fill) * SCALE;

  return (
    <svg viewBox="0 0 120 196" className="h-56 w-[137px] shrink-0" role="img" aria-label="a tap dripping into a bottle in real time">
      <rect x={46} y={0} width={28} height={8} fill="#4d73ad" />
      <rect x={56} y={8} width={8} height={10} fill="#4d73ad" />

      {stream ? (
        <line
          className="drip-stream"
          x1={60}
          x2={60}
          y1={DROP_START_Y - 2}
          y2={surfaceY}
          stroke="#5b9fd0"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      ) : (
        drops.map(({ id }) => (
          <g key={id}>
            <g transform={`translate(60 ${DROP_START_Y})`}>
              <path
                className="drip-fall"
                d="M0,-4 C1.5,-1.5 2.6,0 2.6,1.4 A2.6,2.6 0 0 1 -2.6,1.4 C-2.6,0 -1.5,-1.5 0,-4 Z"
                fill="#5b9fd0"
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
              stroke="#5b9fd0"
              style={{ animationDelay: `${FALL_MS}ms`, animationDuration: `${RIPPLE_MS}ms` }}
            />
          </g>
        ))
      )}

      <g transform={`translate(${BOTTLE_X} ${BOTTLE_Y}) scale(${SCALE})`}>
        <Bottle fill={fill} cap={false} />
      </g>
    </svg>
  );
}

/** height of each bottle size in the flat view, in px */
const FLAT_HEIGHT: Record<number, number> = { 1: 32, 10: 44, 100: 60, 1_000: 80, 10_000: 104, 100_000: 132 };

/** flat fallback: one row per bottle size, biggest first */
function FlatGrid({ groups }: { groups: BottleGroup[] }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
      {groups.map((g) => (
        <div key={g.size}>
          <div className="flex flex-wrap items-end gap-1">
            {g.fills.map((f, i) => (
              <Bottle key={i} fill={f} className="w-auto" style={{ height: FLAT_HEIGHT[g.size] }} />
            ))}
          </div>
          <p className="mt-1 text-xs text-water-deep">{groupLabel(g)}</p>
        </div>
      ))}
    </div>
  );
}

export function BottleSimulation({
  dropsPerMin,
  intervalMs,
  litersPerDay,
  stream: isStream = false,
}: {
  dropsPerMin: number;
  intervalMs: number;
  litersPerDay: number;
  /** the leak is a steady stream rather than drops */
  stream?: boolean;
}) {
  const [period, setPeriod] = useState("year");
  const [webgl] = useState(hasWebGL);
  const { drops, landed, stream } = useLiveDrops(dropsPerMin, intervalMs);

  const inBottle = landed % DROPS_PER_BOTTLE;
  const liveFill = inBottle / DROPS_PER_BOTTLE;
  const bottlesDone = Math.floor(landed / DROPS_PER_BOTTLE);
  const minutesPerBottle = DROPS_PER_BOTTLE / dropsPerMin;

  const days = PERIOD_OPTIONS.find(([label]) => label === period)?.[1] ?? 1;
  const bottles = (litersPerDay * 1000 * days) / BOTTLE_ML;
  const groups = useMemo(() => bottleGroups(bottles), [bottles]);

  const flat = (
    <div className="space-y-6">
      <FlatLiveBottle drops={drops} stream={stream} fill={liveFill} />
      <FlatGrid groups={groups} />
    </div>
  );

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm">
          <span className="text-water-deep font-semibold">{formatBottles(bottles)}</span> bottle{bottles === 1 ? "" : "s"} a {period}
        </p>
        <span className="inline-flex overflow-hidden rounded-full border-[3px] border-water-deep">
          {PERIOD_OPTIONS.map(([label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setPeriod(label)}
              className={`px-3 py-0.5 text-sm font-medium ${label === period ? "bg-water-deep text-white" : "bg-white text-water-deep hover:bg-sky"}`}
            >
              {label}
            </button>
          ))}
        </span>
      </div>

      {webgl ? (
        <SceneBoundary fallback={flat}>
          <Suspense fallback={<div className="h-80 rounded-2xl border-[3px] border-water-deep bg-sky-soft sm:h-96" />}>
            <BottleScene groups={groups} liveFill={liveFill} drops={drops} stream={stream} />
          </Suspense>
        </SceneBoundary>
      ) : (
        flat
      )}

      <p className="mt-2 text-xs text-water-deep">
        {groups.map(groupLabel).join(" + ")}. a normal bottle is {BOTTLE_ML} ml
        (about 2 cups); each bigger size stands for 10× the one before it, up to 100,000.
      </p>

      <div className="mt-4 text-sm">
        <p className="tabular-nums">
          front bottle: {Math.floor(inBottle).toLocaleString("en-US")} / {Math.round(DROPS_PER_BOTTLE).toLocaleString("en-US")} drops
        </p>
        <p className="mt-1 text-xs text-water-deep">
          {bottlesDone > 0 ? `${bottlesDone} bottle${bottlesDone === 1 ? "" : "s"} filled so far. ` : ""}
          fills one bottle every{" "}
          {minutesPerBottle < 60 ? `${Math.max(1, Math.round(minutesPerBottle))} min` : formatDuration(minutesPerBottle / 1440)}.{" "}
          {isStream
            ? "real time: a steady stream."
            : stream
            ? `real time: about ${Math.round(dropsPerMin / 60)} drops a second, too fast to see one by one.`
            : `real time: one drop every ${(intervalMs / 1000).toFixed(1)} s.`}
        </p>
      </div>
    </div>
  );
}
