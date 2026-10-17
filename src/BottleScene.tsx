import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Edges, OrbitControls } from "@react-three/drei";
import { DoubleSide, LatheGeometry, Vector2, type Mesh, type MeshBasicMaterial } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { FALL_MS, RIPPLE_MS, type LiveDrop } from "@/lib/useLiveDrops";

const INK = "#171717";
const WATER = "#2563eb";

// bottle outline as (radius, height) from the base up; the bottle is 1 unit tall
const PROFILE: [number, number][] = [
  [0, 0],
  [0.16, 0],
  [0.2, 0.04],
  [0.2, 0.2],
  [0.175, 0.23],
  [0.2, 0.26],
  [0.2, 0.38],
  [0.175, 0.41],
  [0.2, 0.44],
  [0.2, 0.56],
  [0.175, 0.59],
  [0.2, 0.62],
  [0.2, 0.7],
  [0.085, 0.86],
  [0.085, 0.9],
];
/** the water stops just under the neck */
const WATER_MAX = 0.84;
const SPACING = 0.6;
/** where the live bottle stands, in front of the rows */
const LIVE_Z = 1.3;
const DROP_START_Y = 1.68;

function radiusAt(y: number) {
  for (let i = 1; i < PROFILE.length; i++) {
    const [r0, y0] = PROFILE[i - 1];
    const [r1, y1] = PROFILE[i];
    if (y <= y1 && y1 > y0) return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
  }
  return PROFILE[PROFILE.length - 1][0];
}

const bodyGeometry = new LatheGeometry(
  PROFILE.map(([r, y]) => new Vector2(r, y)),
  32,
);

const waterCache = new Map<number, LatheGeometry>();
/** the water inside a bottle, as a solid filled to the given fraction */
function waterGeometry(fill: number) {
  const key = Math.round(fill * 200) / 200;
  let geo = waterCache.get(key);
  if (!geo) {
    const top = key * WATER_MAX;
    const pts = [new Vector2(0, 0.005)];
    for (const [r, y] of PROFILE) {
      if (y <= 0 || y >= top) continue;
      pts.push(new Vector2(r * 0.93, y));
    }
    pts.push(new Vector2(radiusAt(top) * 0.93, top), new Vector2(0, top));
    geo = new LatheGeometry(pts, 32);
    waterCache.set(key, geo);
  }
  return geo;
}

function Bottle3D({ fill, position, cap = true }: { fill: number; position: [number, number, number]; cap?: boolean }) {
  const water = useMemo(() => (fill > 0.004 ? waterGeometry(fill) : null), [fill]);
  return (
    <group position={position}>
      {water && (
        <mesh geometry={water} renderOrder={1}>
          <meshStandardMaterial color={WATER} transparent opacity={0.65} roughness={0.2} />
        </mesh>
      )}
      <mesh geometry={bodyGeometry} renderOrder={2}>
        <meshStandardMaterial color="#ffffff" transparent opacity={0.3} roughness={0.15} side={DoubleSide} depthWrite={false} />
        <Edges threshold={50} color={INK} />
      </mesh>
      {cap && (
        <mesh position={[0, 0.94, 0]}>
          <cylinderGeometry args={[0.09, 0.09, 0.08, 24]} />
          <meshStandardMaterial color={INK} roughness={0.6} />
        </mesh>
      )}
    </group>
  );
}

/** a standing tap that drips into the live bottle */
function Tap() {
  return (
    <group position={[0, 0, LIVE_Z]}>
      <mesh position={[-0.6, 0.9, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 1.8, 16]} />
        <meshStandardMaterial color={INK} />
      </mesh>
      <mesh position={[-0.3, 1.8, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.035, 0.035, 0.6, 16]} />
        <meshStandardMaterial color={INK} />
      </mesh>
      <mesh position={[0, 1.74, 0]}>
        <cylinderGeometry args={[0.035, 0.03, 0.12, 16]} />
        <meshStandardMaterial color={INK} />
      </mesh>
    </group>
  );
}

function Drop({ spawnedAt, surfaceY }: { spawnedAt: number; surfaceY: number }) {
  const drop = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const ringMaterial = useRef<MeshBasicMaterial>(null);

  useFrame(() => {
    if (!drop.current || !ring.current || !ringMaterial.current) return;
    const elapsed = performance.now() - spawnedAt;
    if (elapsed < FALL_MS) {
      const p = elapsed / FALL_MS;
      drop.current.visible = true;
      drop.current.position.y = DROP_START_Y - (DROP_START_Y - surfaceY) * p * p;
      ring.current.visible = false;
    } else {
      drop.current.visible = false;
      const p = (elapsed - FALL_MS) / RIPPLE_MS;
      ring.current.visible = p < 1;
      ring.current.scale.setScalar(0.2 + 0.8 * p);
      ringMaterial.current.opacity = 1 - p;
    }
  });

  return (
    <group position={[0, 0, LIVE_Z]}>
      <mesh ref={drop} position={[0, DROP_START_Y, 0]} scale={[1, 1.4, 1]}>
        <sphereGeometry args={[0.025, 12, 12]} />
        <meshStandardMaterial color={WATER} />
      </mesh>
      <mesh ref={ring} position={[0, surfaceY + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.13, 0.145, 32]} />
        <meshBasicMaterial ref={ringMaterial} color={WATER} transparent />
      </mesh>
    </group>
  );
}

/** points the camera at the rows whenever their size changes */
function Framing({ cols, rows, controls }: { cols: number; rows: number; controls: React.RefObject<OrbitControlsImpl> }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const depth = (rows - 1) * SPACING;
    const width = (cols - 1) * SPACING;
    const centerZ = (LIVE_Z - depth) / 2;
    const dist = Math.max(4.2, Math.max(width, depth + LIVE_Z) * 1.8);
    camera.position.set(dist * 0.5, dist * 0.75, centerZ + dist * 0.8);
    const c = controls.current;
    if (c) {
      c.target.set(0, 0.45, centerZ);
      c.update();
      c.saveState();
    }
  }, [cols, rows, camera, controls]);
  return null;
}

export default function BottleScene({
  fills,
  liveFill,
  drops,
  stream,
}: {
  fills: number[];
  liveFill: number;
  drops: LiveDrop[];
  stream: boolean;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const [spinning, setSpinning] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const cols = Math.min(10, Math.max(1, Math.ceil(Math.sqrt(fills.length * 1.6))));
  const rows = Math.ceil(fills.length / cols);
  const surfaceY = Math.max(0.01, liveFill * WATER_MAX);

  return (
    <div className="relative h-80 border border-neutral-200 sm:h-96">
      <Canvas camera={{ fov: 40 }} dpr={[1, 2]} aria-label="3d view of the water bottles">
        <color attach="background" args={["#ffffff"]} />
        <ambientLight intensity={1.6} />
        <directionalLight position={[3, 6, 4]} intensity={1.4} />

        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]}>
          <planeGeometry args={[40, 40]} />
          <meshStandardMaterial color="#fafafa" />
        </mesh>
        <gridHelper args={[40, 80, "#e5e5e5", "#efefef"]} />

        {fills.map((f, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          return <Bottle3D key={i} fill={f} position={[(col - (cols - 1) / 2) * SPACING, 0, -row * SPACING]} />;
        })}

        <Tap />
        <Bottle3D fill={liveFill} position={[0, 0, LIVE_Z]} cap={false} />
        {stream ? (
          <mesh position={[0, (DROP_START_Y + surfaceY) / 2, LIVE_Z]}>
            <cylinderGeometry args={[0.012, 0.012, DROP_START_Y - surfaceY, 8]} />
            <meshStandardMaterial color={WATER} transparent opacity={0.8} />
          </mesh>
        ) : (
          drops.map((d) => <Drop key={d.id} spawnedAt={d.spawnedAt} surfaceY={surfaceY} />)
        )}

        <OrbitControls
          ref={controls}
          makeDefault
          enableDamping
          autoRotate={spinning}
          autoRotateSpeed={0.6}
          minDistance={1.2}
          maxDistance={20}
          maxPolarAngle={Math.PI / 2 - 0.05}
          onStart={() => setSpinning(false)}
        />
        <Framing cols={cols} rows={rows} controls={controls} />
      </Canvas>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2">
        <span className="text-xs text-neutral-500">drag to turn · scroll or pinch to zoom · right-drag to pan</span>
        <button
          type="button"
          onClick={() => controls.current?.reset()}
          className="pointer-events-auto shrink-0 border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:border-neutral-900"
        >
          reset view
        </button>
      </div>
    </div>
  );
}
