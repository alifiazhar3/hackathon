/**
 * small pictures drawn in the drippy logo's style: soft fills with a thick,
 * rounded blue outline. each is a 64 × 64 svg sized by its className.
 */
import type { ReactNode } from "react";

const OUT = "#4d73ad";
const WATER = "#8ec3e3";
const WATER_DEEP = "#5b9fd0";
const CORAL = "#f2735a";
const CORAL_LIGHT = "#ffd6cc";
const LEAF_LIGHT = "#d4f2d9";
const SUN = "#f6c344";
const SUN_LIGHT = "#fff1c2";
const WHITE = "#ffffff";
const GREY = "#c9d6e6";

type Props = { className?: string };

function Pic({ className = "h-10 w-10", children, label }: Props & { children: ReactNode; label?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      stroke={OUT}
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

const drop = (x: number, y: number, s: number) =>
  `M${x},${y - 10 * s} C${x + 3 * s},${y - 5 * s} ${x + 7 * s},${y - 1 * s} ${x + 7 * s},${y + 3 * s} A${7 * s},${7 * s} 0 0 1 ${x - 7 * s},${y + 3 * s} C${x - 7 * s},${y - 1 * s} ${x - 3 * s},${y - 5 * s} ${x},${y - 10 * s} Z`;

export function DropPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d={drop(32, 30, 2.3)} fill={WATER} />
      <path d="M24 36 q0 6 6 8" stroke={WHITE} strokeWidth={3} />
    </Pic>
  );
}

export function TapPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d="M8 18 h26 a10 10 0 0 1 10 10 v4 h-10 v-4 h-26 z" fill={GREY} />
      <rect x="16" y="10" width="10" height="8" rx="3" fill={GREY} />
      <rect x="11" y="6" width="20" height="5" rx="2.5" fill={WATER_DEEP} />
      <path d={drop(39, 50, 1.1)} fill={WATER} />
    </Pic>
  );
}

export function MicPic({ className }: Props) {
  return (
    <Pic className={className}>
      <rect x="23" y="8" width="18" height="30" rx="9" fill={WATER} />
      <path d="M16 30 a16 16 0 0 0 32 0" />
      <path d="M32 46 v10 M24 56 h16" />
    </Pic>
  );
}

export function CameraPic({ className }: Props) {
  return (
    <Pic className={className}>
      <rect x="8" y="18" width="48" height="34" rx="8" fill={WATER} />
      <path d="M22 18 l4 -7 h12 l4 7" fill={GREY} />
      <circle cx="32" cy="35" r="10" fill={WHITE} />
      <circle cx="32" cy="35" r="4" fill={OUT} stroke="none" />
    </Pic>
  );
}

export function FingerPic({ className }: Props) {
  return (
    <Pic className={className}>
      <circle cx="32" cy="16" r="10" stroke={SUN} strokeDasharray="4 5" />
      <path d="M28 16 v26 l-6 -5 a4 4 0 0 0 -6 5 l10 12 h18 a6 6 0 0 0 6 -6 v-12 a4 4 0 0 0 -8 0 v-2 a4 4 0 0 0 -8 0 v-18 a3 3 0 0 0 -6 0 z" fill={SUN_LIGHT} />
    </Pic>
  );
}

export function FilmPic({ className }: Props) {
  return (
    <Pic className={className}>
      <rect x="8" y="12" width="48" height="40" rx="6" fill={GREY} />
      <rect x="16" y="20" width="32" height="24" rx="3" fill={WATER} />
      <path d="M12 18 v4 M12 30 v4 M12 42 v4 M52 18 v4 M52 30 v4 M52 42 v4" strokeWidth={3} />
      <path d="M29 26 l9 6 l-9 6 z" fill={WHITE} />
    </Pic>
  );
}

export function CoinsPic({ className }: Props) {
  return (
    <Pic className={className}>
      {[48, 40, 32].map((y) => (
        <g key={y}>
          <path d={`M8 ${y} v5 a12 5 0 0 0 24 0 v-5`} fill={SUN} />
          <ellipse cx="20" cy={y} rx="12" ry="5" fill={SUN_LIGHT} />
        </g>
      ))}
      <circle cx="44" cy="30" r="13" fill={SUN} />
      <text x="44" y="36" textAnchor="middle" fontSize="17" fontWeight="700" fill={OUT} stroke="none" fontFamily="Fredoka, sans-serif">
        $
      </text>
    </Pic>
  );
}

export function PiggyPic({ className }: Props) {
  return (
    <Pic className={className}>
      <ellipse cx="32" cy="36" rx="20" ry="15" fill={CORAL_LIGHT} />
      <path d="M22 22 l-4 -8 l9 5" fill={CORAL_LIGHT} />
      <circle cx="40" cy="32" r="2" fill={OUT} stroke="none" />
      <path d="M50 34 h6 v6 h-6" fill={CORAL_LIGHT} />
      <path d="M22 50 v6 M40 50 v6" />
      <path d="M27 21 h10" stroke={SUN} strokeWidth={4} />
    </Pic>
  );
}

export function SunPic({ className }: Props) {
  return (
    <Pic className={className}>
      <circle cx="32" cy="32" r="12" fill={SUN} />
      <path d="M32 8 v6 M32 50 v6 M8 32 h6 M50 32 h6 M15 15 l4 4 M45 45 l4 4 M15 49 l4 -4 M45 19 l4 -4" stroke={SUN} />
    </Pic>
  );
}

export function CalendarPic({ className, mark = "" }: Props & { mark?: string }) {
  return (
    <Pic className={className}>
      <rect x="10" y="14" width="44" height="40" rx="7" fill={WHITE} />
      <path d="M10 26 h44" />
      <path d="M10 21 a7 7 0 0 1 7 -7 h30 a7 7 0 0 1 7 7 v5 h-44 z" fill={CORAL} />
      <path d="M22 9 v9 M42 9 v9" />
      <text x="32" y="47" textAnchor="middle" fontSize="16" fontWeight="700" fill={OUT} stroke="none" fontFamily="Fredoka, sans-serif">
        {mark}
      </text>
    </Pic>
  );
}

export function HourglassPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d="M18 8 h28 M18 56 h28" strokeWidth={4} />
      <path d="M21 8 c0 14 22 14 22 24 c0 10 -22 10 -22 24 h22 c0 -14 -22 -14 -22 -24 c0 -10 22 -10 22 -24 z" fill={WHITE} />
      <path d="M25 50 q7 -8 14 0 z" fill={SUN} stroke="none" />
      <path d="M26 16 h12 q-6 8 -12 0 z" fill={SUN} stroke="none" />
    </Pic>
  );
}

export function WrenchPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d="M44 8 a12 12 0 0 0 -12 16 l-22 22 a5 5 0 0 0 8 8 l22 -22 a12 12 0 0 0 16 -12 l-7 7 l-6 -1 l-1 -6 z" fill={LEAF_LIGHT} />
    </Pic>
  );
}

export function BucketPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d="M14 24 h36 l-5 30 h-26 z" fill={GREY} />
      <path d="M14 24 q18 -22 36 0" />
      <path d="M18 34 h28" stroke={WATER} strokeWidth={5} />
      <path d={drop(32, 14, 0.8)} fill={WATER} />
    </Pic>
  );
}

function Face({ happy }: { happy: boolean }) {
  return happy ? (
    <>
      <circle cx="26" cy="38" r="2.2" fill={OUT} stroke="none" />
      <circle cx="38" cy="38" r="2.2" fill={OUT} stroke="none" />
      <path d="M26 45 q6 6 12 0" />
    </>
  ) : (
    <>
      <path d="M23 38 q3 2 6 0 M35 38 q3 2 6 0" />
      <path d="M28 47 h8" />
      <text x="44" y="22" fontSize="10" fill={OUT} stroke="none" fontFamily="Fredoka, sans-serif">
        z
      </text>
    </>
  );
}

export function HappyDropPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d={drop(32, 34, 2.4)} fill={LEAF_LIGHT} />
      <Face happy />
    </Pic>
  );
}

export function SleepyDropPic({ className }: Props) {
  return (
    <Pic className={className}>
      <path d={drop(32, 34, 2.4)} fill={WATER} />
      <Face happy={false} />
    </Pic>
  );
}

export function BottlePic({ className }: Props) {
  return (
    <Pic className={className}>
      <rect x="26" y="4" width="12" height="7" rx="2" fill={OUT} stroke="none" />
      <path d="M27 11 l-9 12 v30 a5 5 0 0 0 5 5 h18 a5 5 0 0 0 5 -5 v-30 l-9 -12 z" fill={WHITE} />
      <path d="M18 32 q7 -4 14 0 t14 0 v21 a5 5 0 0 1 -5 5 h-18 a5 5 0 0 1 -5 -5 z" fill={WATER} stroke="none" />
      <path d="M27 11 l-9 12 v30 a5 5 0 0 0 5 5 h18 a5 5 0 0 0 5 -5 v-30 l-9 -12 z" />
    </Pic>
  );
}

/** a row of little drops between sections */
export function DropsDivider() {
  return (
    <div className="flex justify-center gap-3 py-1" aria-hidden="true">
      {[0.7, 1, 0.7].map((s, i) => (
        <svg key={i} viewBox="0 0 20 24" className="bob" style={{ width: 14 * s, height: 17 * s, animationDelay: `${i * 0.3}s` }}>
          <path d="M10 2 C12 6 17 10 17 15 A7 7 0 0 1 3 15 C3 10 8 6 10 2 Z" fill={WATER} stroke={OUT} strokeWidth={2.5} />
        </svg>
      ))}
    </div>
  );
}
